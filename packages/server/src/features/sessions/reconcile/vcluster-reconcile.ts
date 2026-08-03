import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type TickSnapshot,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  listSessionJobs,
  listSessionPods,
  listVclusterNamespaces,
} from '#platform/k8s'
import {
  buildVclusterSleepEndpointSliceManifest,
  getActivatorPodIp,
  removeSessionVcluster,
  VCLUSTER_ORPHAN_GRACE_MS,
  vclusterLabels,
  vclusterSleepSliceName,
  waitForVclusterKubeconfig,
} from '#features/cluster'
import { sessionVclusterDir } from '@yaac/shared/project-paths'

/**
 * Converge one live vcluster's sleep interception (the EndpointSlice an
 * asleep vcluster's API Service resolves to — docs/vcluster-scale-to-zero.md)
 * with the control-plane Deployment's actual state:
 *
 *   - asleep (replicas 0): the slice must exist and target the LIVE
 *     activator pod — an activator pod replacement changes the IP and
 *     would otherwise strand every asleep vcluster unreachable; a
 *     missing slice (reconcile raced a sleep, manual delete) is a
 *     black-holed API and is recreated.
 *   - awake and serving: the slice must be gone (the activator deletes
 *     it on wake; this covers a failed delete). While WAKING the slice
 *     is left alone — the activator still needs it to catch clients.
 *
 * `labels` are the vcluster ownership labels for a recreated slice.
 */
export async function healVclusterSleepState(
  name: string,
  namespace: string,
  labels: Record<string, string>,
): Promise<void> {
  const dep = await kubectlGetJson<{
    spec?: { replicas?: number }
    status?: { readyReplicas?: number }
  }>(['get', 'deployment', name, '-n', namespace])
  if (!dep) return
  const sliceName = vclusterSleepSliceName(name)
  const slice = await kubectlGetJson<{ endpoints?: Array<{ addresses?: string[] }> }>([
    'get', 'endpointslice', sliceName, '-n', namespace,
  ])
  if ((dep.spec?.replicas ?? 0) >= 1) {
    if (slice && (dep.status?.readyReplicas ?? 0) >= 1) {
      await kubectlWithRetry([
        'delete', 'endpointslice', sliceName, '-n', namespace, '--ignore-not-found',
      ])
    }
    return
  }
  // No live activator (not deployed yet, mid-replacement): nothing to
  // point the slice at — leave state as-is and heal on a later tick.
  const activatorIp = await getActivatorPodIp().catch(() => null)
  if (!activatorIp) return
  if (slice?.endpoints?.[0]?.addresses?.[0] === activatorIp) return
  await kubectlApply(buildVclusterSleepEndpointSliceManifest(name, namespace, labels, activatorIp))
}

/**
 * Reconcile step for per-session vclusters:
 *
 *   - Orphan GC: a vcluster whose owning session no longer exists (pod
 *     AND Job gone — covers crashes, reaped zombies, out-of-band
 *     deletes) is torn down. The per-install scope label keeps
 *     coexisting installs out of each other's vclusters.
 *   - Kubeconfig heal: a live session whose host-side kubeconfig file
 *     vanished (host cleanup mishap, restored backup) gets it rewritten
 *     from the syncer's secret — the dir is hostPath-mounted, so the
 *     file lands back inside the running session without a remount.
 *
 * Best-effort throughout; the loop isolates step errors.
 *
 * `nowMs` is injectable for tests; defaults to the wall clock (the
 * orphan-GC grace window is the only time-dependent part).
 */
export async function reconcileVclusters(
  nowMs: number = Date.now(),
  snapshot?: TickSnapshot,
): Promise<void> {
  const vclusters = await (snapshot ? snapshot.vclusters() : listVclusterNamespaces())
  if (vclusters.length === 0) return

  // Union of pod + Job session ids, same as the modules GC: a Job
  // mid-recreate only shows in the Job list and must not be reaped.
  const [pods, jobs] = await Promise.all([
    snapshot ? snapshot.pods() : listSessionPods(),
    snapshot ? snapshot.jobs() : listSessionJobs(),
  ])
  const liveSids = new Set([
    ...pods.map((p) => p.sessionId),
    ...jobs.map((j) => j.sessionId),
  ].filter((id) => !!id))
  const slugBySid = new Map(pods.map((p) => [p.sessionId, p.projectSlug]))

  for (const { name, sessionId, namespace, creationTimestamp } of vclusters) {
    if (!liveSids.has(sessionId)) {
      // Grace window: a vcluster created moments ago by an in-flight
      // session create has no live pod/Job advertising its session-id
      // yet (the Job mounts the vcluster's kubeconfig, so the vcluster
      // is created first). Reaping it here would kill the very session
      // that is provisioning it. Only reap once it is comfortably older
      // than a cold create.
      const created = Date.parse(creationTimestamp)
      if (Number.isFinite(created) && nowMs - created < VCLUSTER_ORPHAN_GRACE_MS) continue
      console.log(`Removing orphan vcluster ${name} (session ${sessionId} is gone)`)
      await removeSessionVcluster(name)
      continue
    }

    try {
      await healVclusterSleepState(name, namespace, vclusterLabels(name, sessionId))
    } catch (err) {
      console.warn(`vcluster sleep-state heal (${name}): ${(err as Error).message}`)
    }

    const slug = slugBySid.get(sessionId)
    if (!slug) continue // Job mid-recreate — heal on a later tick
    const configPath = path.join(sessionVclusterDir(slug, sessionId), 'config')
    const present = await fs.access(configPath).then(() => true).catch(() => false)
    if (present) continue
    try {
      // The secret already exists for a settled vcluster — use a short
      // wait so a mid-provision vcluster doesn't stall the tick.
      const kubeconfig = await waitForVclusterKubeconfig(name, 5_000)
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, kubeconfig, { mode: 0o600 })
      console.log(`Healed vcluster kubeconfig for session ${sessionId}`)
    } catch (err) {
      console.warn(`vcluster kubeconfig heal (${name}): ${(err as Error).message}`)
    }
  }
}
