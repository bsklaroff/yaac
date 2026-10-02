import {
  LABEL_NPM_CACHE,
  LABEL_PREWARMED,
  LABEL_TOOL,
  findWorkspacePod,
  isPrewarmed,
  k8sNamespace,
  kubectlWithRetry,
  NPM_CACHE_APP_NAME,
  readWorkspacePods,
} from '#drivers/k8s/substrate'
import { servingNpmCacheUrl } from '#drivers/k8s/cluster'
import { registerWorkspaceEgress } from '#drivers/k8s/egress'
import type { AgentTool } from '@yaac/shared/types'
import type { WorkspaceRegistration } from '#drivers/contract'
import { serverLog } from '#log'
import { npmCacheApplies } from './launch'

/**
 * The commit point of a prewarm claim, where a spare becomes the user's
 * workspace (docs/layered-server.md). Everything before it is reversible,
 * so it is a single call that either takes the spare or refuses.
 */

/** A label key as a JSON Pointer segment (RFC 6901 escaping). */
function pointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * Claim the spare holding `workspaceId` for `tool`.
 *
 * The write is a compare-and-swap: a JSON-patch `test` op makes the API
 * server reject a second concurrent claim with a 422 (not retried). A
 * label-selector bulk update would not do this, because it lists and then
 * patches unconditionally. The loser throws, which sends its claim down the
 * cold-create path. The prewarm mediator also reserves spares in-process,
 * but this keeps the verb safe for any caller.
 *
 * Known gap: if the patch lands but its response is lost and retried, the
 * retry fails its own `test` and a winning claim reports a loss. The caller
 * then rolls back a spare that is already claimed; it stays hidden until
 * its agent dies. Fixing this would need a per-claim mark written in the
 * patch, and the window is a lost response on one round trip.
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
  await kubectlWithRetry([
    'patch', 'pod', podName, '-n', k8sNamespace(), '--type=json', '-p',
    JSON.stringify([
      // Checked at write time, not just at list time.
      { op: 'test', path: `/metadata/labels/${pointerSegment(LABEL_PREWARMED)}`, value: 'true' },
      { op: 'remove', path: `/metadata/labels/${pointerSegment(LABEL_PREWARMED)}` },
      // `add` sets the label whether or not it already exists.
      { op: 'add', path: `/metadata/labels/${pointerSegment(LABEL_TOOL)}`, value: tool },
    ]),
  ])

  // Re-decide the npm registry at claim time: the spare's init chose it
  // long ago, and pnpm has no fallback if the cache has since gone down
  // (`servingNpmCacheUrl`). Best-effort.
  if (pod.labels[LABEL_NPM_CACHE] === 'true') {
    await servingNpmCacheUrl().then((url) => writeNpmRegistry(podName, url)).catch((err: unknown) => {
      serverLog(`[prewarm] could not re-decide the npm registry of ${podName}: ${String(err)}`)
    })
  }
}

/**
 * Apply a project's current egress config to a live workspace, e.g. when a
 * claim picks up a spare warmed long ago.
 *
 * Besides the proxy registration, npm-cache access is a pod label set at
 * launch. The cache fetches outside the proxy, so if the allowlist no longer
 * admits npmjs the pod is taken off the cache: first ~/.npmrc stops naming
 * it, then the label is removed. In that order, a failure in between leaves
 * a pod that can still reach the cache, and the next registration retries.
 * A widened allowlist is left alone; without the cache, npmjs is still
 * reachable through the proxy.
 */
export async function registerWorkspace(reg: WorkspaceRegistration): Promise<void> {
  const registration = await registerWorkspaceEgress(reg)
  if (npmCacheApplies(reg.config, registration.allowedHosts, reg.proxySecretRules)) return
  const pod = findWorkspacePod(await readWorkspacePods(), reg.workspaceId, { spares: true })
  if (pod?.labels[LABEL_NPM_CACHE] !== 'true') return
  await writeNpmRegistry(pod.podName, null)
  await kubectlWithRetry(['label', 'pod', pod.podName, '-n', k8sNamespace(), `${LABEL_NPM_CACHE}-`])
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
  await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), podName, '--',
    'sh', '-c', script, '--', url ?? '',
  ], { maxAttempts: 2 })
}
