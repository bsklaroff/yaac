import fs from 'node:fs/promises'
import path from 'node:path'
import { listSessionJobs, listSessionPods } from '#platform/k8s/pods'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import {
  listVclusterNamespaces,
  removeSessionVcluster,
  VCLUSTER_ORPHAN_GRACE_MS,
  waitForVclusterKubeconfig,
} from '#features/cluster/vcluster'
import { sessionVclusterDir } from '@yaac/shared/project-paths'

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

  for (const { name, sessionId, creationTimestamp } of vclusters) {
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
