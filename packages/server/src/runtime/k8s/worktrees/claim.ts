import {
  LABEL_DATA_DIR_HASH,
  LABEL_PREWARMED,
  LABEL_TOOL,
  LABEL_WORKTREE_ID_LEGACY,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
} from '#runtime/k8s/substrate'
import type { AgentTool } from '@yaac/shared/types'

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
 * is what a `yaac-spawn` from the claimed workspace reads to decide what to
 * run.
 */
export async function claimSpareWorkspace(
  workspaceId: string,
  tool: AgentTool,
): Promise<void> {
  const selector = [
    `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
    `${LABEL_WORKTREE_ID_LEGACY}=${workspaceId}`,
    `${LABEL_PREWARMED}=true`,
  ].join(',')

  const list = await kubectlGetJson<{ items?: Array<{ metadata?: { name?: string } }> }>([
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
}
