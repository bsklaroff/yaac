import {
  LABEL_NPM_CACHE,
  LABEL_PREWARMED,
  findWorkspacePod,
  isPrewarmed,
  execFileAsync,
  k8sNamespace,
  NPM_CACHE_APP_NAME,
  patchObject,
  readWorkspaceJobs,
  readWorkspacePods,
  removeLabelIf,
} from '#drivers/k8s/substrate'
import { servingNpmCacheUrl } from '#drivers/k8s/cluster'
import { registerWorkspaceEgress } from '#drivers/k8s/egress'
import type { WorkspaceRegistration } from '#drivers/contract'
import { serverLog } from '#lib/log'
import { npmCacheApplies } from './launch'

/**
 * Where a claimed spare stops being one in the cluster
 * (docs/layered-server.md): a conditional write on its pod that either
 * takes the spare or refuses, then the same label off its Job.
 */

/**
 * Claim the spare holding `workspaceId`: unlabel its pod, which is the
 * claim, then its Job, which the returned `unmarked` reports. The Job's
 * label is what identifies a spare whose pod is gone, and a reap deletes
 * such a spare's files, so the Job loses it only once the pod has, and a
 * caller waits for `unmarked` before it counts the claim as done.
 *
 * The pod's write is a compare-and-swap in one request (`removeLabelIf`):
 * the API server removes the label only from a pod that still has it, so
 * it refuses a second concurrent claim. A label-selector bulk update would
 * not do this, because it lists and then patches unconditionally. The
 * loser throws, which sends its claim down the cold-create path. The
 * prewarm mediator also reserves spares in-process, but this keeps the
 * verb safe for any caller.
 *
 * If the write lands but its response is lost, the client's retry is
 * refused like a second claim, so a winning claim reports a loss and the
 * caller reaps the spare rather than return it to the pool.
 */
export async function claimSpareWorkspace(workspaceId: string): Promise<{ unmarked: Promise<void> }> {
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
  await removeLabelIf({ apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() }, LABEL_PREWARMED, 'true')
  return {
    unmarked: patchObject(
      { apiVersion: 'batch/v1', kind: 'Job', name: pod.jobName, namespace: k8sNamespace() },
      { metadata: { labels: { [LABEL_PREWARMED]: null } } },
    ),
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
 * Apply a project's current egress config to a live workspace: a spare
 * being claimed, which may have been warmed long ago. Only a claim calls
 * it, beside its `claimSpareWorkspace`, so everything a claim does to the
 * pod's `~/.npmrc` is decided here, in one place.
 *
 * Besides the proxy registration, npm-cache access is a pod label set at
 * launch. The cache fetches outside the proxy, so if the allowlist no longer
 * admits npmjs the pod is taken off the cache: first ~/.npmrc stops naming
 * it, then the label is removed. In that order, a failure in between leaves
 * a pod that can still reach the cache, and the next registration retries.
 * A widened allowlist is left alone; without the cache, npmjs is still
 * reachable through the proxy.
 *
 * A pod that stays on the cache has its registry decided again, since its
 * init chose it at warm time and pnpm has no fallback if the cache has
 * since gone down (`servingNpmCacheUrl`). Best-effort, and not awaited: the
 * agent's first install follows at least one model round trip, far longer
 * than this read and exec.
 */
export async function registerWorkspace(reg: WorkspaceRegistration): Promise<void> {
  const registration = await registerWorkspaceEgress(reg)
  const pod = findWorkspacePod(await readWorkspacePods(), reg.workspaceId, { spares: true })
  if (pod?.labels[LABEL_NPM_CACHE] !== 'true') return
  const { podName } = pod
  if (npmCacheApplies(reg.config, registration.allowedHosts, reg.proxySecretRules)) {
    void servingNpmCacheUrl().then((url) => writeNpmRegistry(podName, url)).catch((err: unknown) => {
      serverLog(`[prewarm] could not re-decide the npm registry of ${podName}: ${String(err)}`)
    })
    return
  }
  await writeNpmRegistry(podName, null)
  await patchObject(
    { apiVersion: 'v1', kind: 'Pod', name: podName, namespace: k8sNamespace() },
    { metadata: { labels: { [LABEL_NPM_CACHE]: null } } },
  )
}

/**
 * Point a pod's pnpm at `url`, or at no cache. Only the cache's own line is
 * removed, and a registry is added only when the file names none, matching
 * the init script.
 */
async function writeNpmRegistry(podName: string, url: string | null): Promise<void> {
  const script = [
    'f="$HOME/.npmrc"',
    `sed -i '\\#^registry=http://${NPM_CACHE_APP_NAME}\\.#d' "$f" 2>/dev/null || true`,
    'if [ -n "$1" ] && ! grep -qs "^registry=" "$f"; then printf "registry=%s\\n" "$1" >> "$f"; fi',
  ].join('\n')
  await execFileAsync('kubectl', [
    'exec', '-n', k8sNamespace(), podName, '--',
    'sh', '-c', script, '--', url ?? '',
  ])
}
