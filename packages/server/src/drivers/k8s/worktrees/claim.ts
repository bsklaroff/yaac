import {
  LABEL_DATA_DIR_HASH,
  LABEL_NPM_CACHE,
  LABEL_PREWARMED,
  LABEL_TOOL,
  LABEL_WORKTREE_ID,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
  NPM_CACHE_APP_NAME,
} from '#drivers/k8s/substrate'
import { servingNpmCacheUrl } from '#drivers/k8s/cluster'
import { registerWorkspaceEgress } from '#drivers/k8s/egress'
import type { AgentTool } from '@yaac/shared/types'
import type { WorkspaceRegistration } from '#drivers/contract'
import { serverLog } from '#log'
import { npmCacheApplies } from './launch'

/**
 * The commit point of a prewarm claim: the moment a spare stops being one
 * (docs/layered-server.md).
 *
 * Everything the claim does before this is reversible — the spare can be
 * released back to the pool untouched — and everything after it is against
 * a workspace that is already the user's. That is why it is one call and
 * why it either takes the spare or refuses: a claim that ran halfway would
 * leave a pod nothing can classify.
 */

/** A label key as a JSON Pointer segment (RFC 6901 escaping). */
function pointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * Claim the spare holding `workspaceId` for `tool`.
 *
 * Addressed by the workspace id rather than by a pod name: the caller holds
 * a `RuntimeHandle`, which names no pod, because the runtime's own naming is
 * not the mediator's to carry.
 *
 * The write is a genuine compare-and-swap, not a filtered bulk update. That
 * distinction is the whole of what makes a claim at-most-once, and it is
 * easy to get wrong: `kubectl label -l <selector>` is a LIST followed by
 * unconditional PATCHes, so two concurrent claimants could both list the pod
 * still prewarmed and both patch it, and both would believe they won. A
 * JSON-patch `test` op makes the API server itself reject the second — it
 * fails the whole patch with a 422, which is not a transient error, so it is
 * not retried into a win. The loser throws, and a throw here is what sends a
 * claim down the cold-create path.
 *
 * Not to be confused with the in-process reservation the prewarm mediator
 * keeps: that stops two claims from ever targeting the same spare inside one
 * server, which is why this race is unobserved today. This is what makes the
 * verb safe for any caller, including one that has no such reservation.
 *
 * One ambiguity survives, and it is the ordinary one for a retried write
 * rather than anything the compare-and-swap introduced: if the patch LANDS
 * but its response is lost to something retryable, the retry meets its own
 * `test` op and gets the 422, so a claim that actually won reports a loss.
 * The caller then rolls back a spare the substrate has already claimed —
 * un-prewarmed, so the pool planner reads it as a live worktree, but flagged
 * `spare` on its row, so no listing shows it — and nothing collects it until
 * its agent dies. Closing it needs a mark unique to this claim, written in
 * the same patch and read back when the retry fails, so "did I win?" is
 * answerable at all; a bare re-read cannot tell this claim's win from
 * another claimant's. Left open deliberately: it costs a stamped field, and
 * the failure needs a lost response on a write that is one round trip long.
 *
 * The tool label is always stamped, not only when it changes. Overwriting it
 * with its own value is a no-op on the substrate and buys an unconditional
 * guarantee above it: once this resolves, the workspace declares `tool`, so
 * every handle observed from here on reports `declaredTool === tool` — which
 * is what a `yaac-mama create` from the claimed workspace reads to decide what to
 * run.
 */
export async function claimSpareWorkspace(
  workspaceId: string,
  tool: AgentTool,
): Promise<void> {
  const selector = [
    `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
    `${LABEL_WORKTREE_ID}=${workspaceId}`,
    `${LABEL_PREWARMED}=true`,
  ].join(',')

  const list = await kubectlGetJson<{
    items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>
  }>([
    'get', 'pods', '-l', selector, '-n', k8sNamespace(),
  ])
  // One pod per workspace id, so the first match is the spare. A second
  // would be a Job mid-replacement, and leaving it prewarmed is right — the
  // pool planner reaps it, and this claim owns exactly one workspace.
  const podName = list?.items?.[0]?.metadata?.name
  if (!podName) {
    throw new Error(
      `no prewarmed spare left to claim for ${workspaceId} `
      + '(already claimed, or its pod is gone)',
    )
  }

  await kubectlWithRetry([
    'patch', 'pod', podName, '-n', k8sNamespace(), '--type=json', '-p',
    JSON.stringify([
      // The compare half: the spare must still be one at WRITE time, not
      // merely at list time.
      { op: 'test', path: `/metadata/labels/${pointerSegment(LABEL_PREWARMED)}`, value: 'true' },
      { op: 'remove', path: `/metadata/labels/${pointerSegment(LABEL_PREWARMED)}` },
      // `add` rather than `replace`: it sets the label whether or not the
      // pod already carries one.
      { op: 'add', path: `/metadata/labels/${pointerSegment(LABEL_TOOL)}`, value: tool },
    ]),
  ])

  // Point a claimed spare's pnpm at the npm cache only if the cache serves
  // NOW. A spare is prepared long before it is claimed, and what its init
  // wrote into ~/.npmrc reflects the cache then — a spare warmed while the
  // cache was up and claimed while it is down would fail every install,
  // since pnpm has no fallback registry (`servingNpmCacheUrl`). Best-effort:
  // a failure leaves what the init wrote.
  if (list?.items?.[0]?.metadata?.labels?.[LABEL_NPM_CACHE] === 'true') {
    await servingNpmCacheUrl().then((url) => writeNpmRegistry(podName, url)).catch((err: unknown) => {
      serverLog(`[prewarm] could not re-decide the npm registry of ${podName}: ${String(err)}`)
    })
  }
}

/**
 * Tell the egress path what a live workspace may reach now — how a claim
 * brings a spare warmed long ago up to its project's current config.
 *
 * The proxy registration is most of that, not all of it: whether the pod may
 * use the npm cache was decided at launch, from the allowlist of THAT moment,
 * and lives on the pod as the label the cache's policies admit. The cache
 * fetches outside the proxy, so a pod keeping the label after its project's
 * allowlist stopped admitting npmjs keeps a path the allowlist now refuses.
 * A registration the cache no longer applies to therefore takes the pod off
 * it: its ~/.npmrc stops naming the cache, then the label goes — in that
 * order, so a failure between the two leaves a pod that could still reach
 * the cache, which the next registration retries, never one whose installs
 * point at a cache it can no longer reach. The reverse, a widened allowlist,
 * is left alone: a pod without the cache fetches npmjs through the proxy,
 * slower but whole.
 */
export async function registerWorkspace(reg: WorkspaceRegistration): Promise<void> {
  const registration = await registerWorkspaceEgress(reg)
  if (npmCacheApplies(reg.config, registration.allowedHosts, reg.proxySecretRules)) return
  const list = await kubectlGetJson<{ items?: Array<{ metadata?: { name?: string } }> }>([
    'get', 'pods', '-n', k8sNamespace(), '-l', [
      `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
      `${LABEL_WORKTREE_ID}=${reg.workspaceId}`,
      `${LABEL_NPM_CACHE}=true`,
    ].join(','),
  ])
  const podName = list?.items?.[0]?.metadata?.name
  if (!podName) return
  await writeNpmRegistry(podName, null)
  await kubectlWithRetry(['label', 'pod', podName, '-n', k8sNamespace(), `${LABEL_NPM_CACHE}-`])
}

/**
 * Point a pod's pnpm at `url`, or at no cache at all. Only the cache's own
 * line is ever removed, so a registry the image names stays, and one is
 * added only where the file names none — the init script's rule.
 */
async function writeNpmRegistry(podName: string, url: string | null): Promise<void> {
  const script = [
    'f="$HOME/.npmrc"',
    `sed -i '\\#^registry=http://${NPM_CACHE_APP_NAME}\\.#d' "$f" 2>/dev/null || true`,
    'if [ -n "$1" ] && ! grep -qs "^registry=" "$f"; then printf "registry=%s\\n" "$1" >> "$f"; fi',
  ].join('\n')
  await kubectlWithRetry([
    'exec', '-n', k8sNamespace(), podName, '-c', 'worktree', '--',
    'sh', '-c', script, '--', url ?? '',
  ], { maxAttempts: 2 })
}
