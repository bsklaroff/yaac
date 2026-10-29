import {
  LABEL_PREWARMED,
  LABEL_TOOL,
  findWorkspacePod,
  isPrewarmed,
  k8sNamespace,
  patchObject,
  readObject,
  readWorkspaceJobs,
  readWorkspacePods,
} from '#drivers/k8s/substrate'
import { servingCacheUrl } from '#drivers/k8s/cluster'
import { registerWorkspaceEgress } from '#drivers/k8s/egress'
import type { AgentTool } from '@yaac/shared/types'
import type { WorkspaceRegistration } from '#drivers/contract'
import { serverLog } from '#lib/log'
import { WORKSPACE_CACHES, cacheApplies, writeCacheConfig } from './package-caches'

/**
 * Where a claimed spare stops being one in the cluster
 * (docs/layered-server.md): a conditional write on its pod that either
 * takes the spare or refuses, then the same labels on its Job.
 */

/**
 * Claim the spare holding `workspaceId` for `tool`: unlabel its pod, then
 * its Job, so neither reads as a spare again. The Job's label is what
 * identifies a spare whose pod is gone, and a reap deletes such a spare's
 * files.
 *
 * The write is a compare-and-swap: the pod is read fresh, and the patch
 * carries the resourceVersion that read saw, so the API server rejects a
 * second concurrent claim with a 409. A label-selector bulk update would
 * not do this, because it lists and then patches unconditionally. The
 * loser throws, which sends its claim down the cold-create path. The
 * prewarm mediator also reserves spares in-process, but this keeps the
 * verb safe for any caller.
 *
 * If a patch lands but its response is lost, a winning claim reports a
 * loss, so the caller reaps the spare rather than return it to the pool.
 *
 * The tool label is always written, even when unchanged, so afterwards every
 * handle reports `declaredTool === tool` (read by `yaac-mama create` from
 * the claimed workspace).
 */
export async function claimSpareWorkspace(
  workspaceId: string,
  tool: AgentTool,
): Promise<void> {
  // One pod per workspace id. A second match would be a Job mid-replacement,
  // which the pool planner reaps.
  const pod = findWorkspacePod(await readWorkspacePods(), workspaceId, { spares: true })
  if (!pod || !isPrewarmed(pod)) {
    throw new Error(
      `no prewarmed spare left to claim for ${workspaceId} `
      + '(already claimed, or its pod is gone)',
    )
  }

  const { podName } = pod
  const ref = { apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() }
  const live = await readObject<{ metadata: { resourceVersion?: string; labels?: Record<string, string> } }>(ref)
  if (live?.metadata.labels?.[LABEL_PREWARMED] !== 'true') {
    throw new Error(`spare ${podName} for ${workspaceId} was claimed by another caller`)
  }
  const labels = { [LABEL_PREWARMED]: null, [LABEL_TOOL]: tool }
  await patchObject(ref, { metadata: { resourceVersion: live.metadata.resourceVersion, labels } })
  await patchObject(
    { apiVersion: 'batch/v1', kind: 'Job', name: pod.jobName, namespace: k8sNamespace() },
    { metadata: { labels } },
  )

  // Re-decide each cache at claim time: the spare's init chose it long ago,
  // and neither pnpm nor cargo falls back if the cache has since gone down
  // (`servingCacheUrl`). Best-effort, and not awaited: the agent's first
  // install follows at least one model round trip, far longer than this
  // read and exec. A rebranch's init windows already ran on the old choice.
  for (const cache of WORKSPACE_CACHES.filter((c) => pod.labels[c.label] === 'true')) {
    void servingCacheUrl(cache).then((url) => writeCacheConfig(podName, cache, url)).catch((err: unknown) => {
      serverLog(`[prewarm] could not re-decide the ${cache.client} cache of ${podName}: ${String(err)}`)
    })
  }
}

/**
 * Remove `yaac.prewarmed` from every Job whose pod a claim has already
 * unlabelled. A claim by an older server unlabelled only the pod, and a
 * spare reap deletes the files of a unit it finds labelled once its row is
 * gone (docs/legacy-compat-shims.md). A Job whose pod is gone cannot be
 * told apart, so it is left alone.
 */
export async function unmarkClaimedJobs(): Promise<void> {
  const [pods, jobs] = await Promise.all([readWorkspacePods(), readWorkspaceJobs()])
  const claimed = new Set(pods.filter((p) => !isPrewarmed(p)).map((p) => p.jobName))
  for (const job of jobs.filter((j) => j.prewarmed && claimed.has(j.jobName))) {
    await patchObject(
      { apiVersion: 'batch/v1', kind: 'Job', name: job.jobName, namespace: k8sNamespace() },
      { metadata: { labels: { [LABEL_PREWARMED]: null } } },
    )
  }
}

/**
 * Apply a project's current egress config to a live workspace, e.g. when a
 * claim picks up a spare warmed long ago.
 *
 * Besides the proxy registration, package-cache access is a pod label set at
 * launch. A cache fetches outside the proxy, so if the config no longer
 * admits the pod to one, the pod is taken off it: first its client config
 * stops naming the cache, then the label is removed. In that order, a
 * failure in between leaves a pod that can still reach the cache, and the
 * next registration retries. A widened allowlist is left alone; without the
 * cache, the upstream is still reachable through the proxy.
 */
export async function registerWorkspace(reg: WorkspaceRegistration): Promise<void> {
  const registration = await registerWorkspaceEgress(reg)
  const revoked = WORKSPACE_CACHES
    .filter((cache) => !cacheApplies(cache, reg.config, registration.allowedHosts, reg.proxySecretRules))
  if (revoked.length === 0) return
  const pod = findWorkspacePod(await readWorkspacePods(), reg.workspaceId, { spares: true })
  if (!pod) return
  for (const cache of revoked.filter((c) => pod.labels[c.label] === 'true')) {
    await writeCacheConfig(pod.podName, cache, null)
    await patchObject(
      { apiVersion: 'v1', kind: 'Pod', name: pod.podName, namespace: k8sNamespace() },
      { metadata: { labels: { [cache.label]: null } } },
    )
  }
}
