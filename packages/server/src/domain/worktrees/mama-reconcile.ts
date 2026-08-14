/**
 * Reconcile step that drains in-worktree `yaac-mama` requests: the runtime
 * holds each waiting worktree's request until someone answers it; this step
 * takes them, resolves who called from the live workspace listing, hands
 * each one to `runMamaCommand`, and reports the answers back so the callers
 * can be released.
 *
 * A drain is a claim: a crash between drain and report loses the request
 * (the caller's request times out where it waits), never doubles it.
 *
 * What a request MEANS is deliberately not here but in `runMamaCommand`:
 * which commands exist at all, what each one does, and what a caller may not
 * ask for are policy — the drain's whole contribution is the queue and
 * attributing each request to its caller (docs/layered-server.md).
 *
 * This is the pull-based transport, which is the only one a sandboxed pod
 * can have: a worktree pod cannot dial the host server, so the proxy holds
 * its request and the server comes to collect. A containerless worktree runs
 * beside the server and posts to it directly (`/worktree/mama`), reaching
 * the same `runMamaCommand` without a queue.
 */
import { worktreeDriver } from '#drivers/driver'
import type { RuntimeHandle, RuntimeSnapshot } from '#drivers/contract'
import { runMamaCommand } from './mama'
import { serverLog } from '#log'
import type { PendingMamaRequest, MamaResultWire } from '@yaac/shared/types'

export interface MamaReconcileDeps {
  fetchPendingFn?: () => Promise<PendingMamaRequest[]>
  postResultsFn?: (results: MamaResultWire[]) => Promise<void>
  listWorkspacesFn?: () => Promise<RuntimeHandle[]>
}

/**
 * Drain queued `yaac-mama` requests from the runtime and answer each one.
 * `snapshot` keeps the caller lookup on the pass's shared runtime view.
 */
export async function reconcileMamaRequests(
  deps: MamaReconcileDeps = {},
  snapshot?: RuntimeSnapshot,
): Promise<void> {
  try {
    const pending = await (deps.fetchPendingFn
      ?? (() => worktreeDriver().pendingMamaRequests()))()
    if (pending.length === 0) return
    // One workspace listing per drain, shared by every request in the batch.
    // A burst at the queue cap must not fan out into a listing per request.
    const listPods = deps.listWorkspacesFn
      ?? (() => (snapshot ?? worktreeDriver().snapshot()).workspaces())
    let pods: Promise<RuntimeHandle[]> | undefined
    const drainDeps: MamaReconcileDeps = {
      ...deps,
      listWorkspacesFn: () => (pods ??= listPods()),
    }
    const results = await Promise.all(pending.map((req) => reportMamaRequest(req, drainDeps)))
    await (deps.postResultsFn
      ?? ((r: MamaResultWire[]) => worktreeDriver().resolveMamaRequests(r)))(results)
  } catch (err) {
    serverLog(`[mama] reconcile failed: ${String(err)}`)
  }
}

/**
 * Answer one request: resolve the caller's project and tool from the live
 * workspace listing, hand it to the command handler, and relay the answer
 * back.
 *
 * The caller lookup is the only judgement made here — a request from a
 * worktree the runtime does not report cannot be attributed to a project,
 * so there is nothing to answer.
 */
async function reportMamaRequest(
  req: PendingMamaRequest,
  deps: MamaReconcileDeps = {},
): Promise<MamaResultWire> {
  const fail = (error: string): MamaResultWire => ({ requestId: req.requestId, ok: false, error })

  // Off a wire, so the field can be missing however the type reads.
  const callerId = req.worktreeId
  if (!callerId) return fail('request names no calling worktree')

  let caller: RuntimeHandle | undefined
  try {
    const pods = await (deps.listWorkspacesFn
      ?? (() => worktreeDriver().snapshot().workspaces()))()
    caller = pods.find((p) => p.workspaceId === callerId)
  } catch (err) {
    return fail(`cannot resolve calling worktree: ${String(err)}`)
  }
  if (!caller) return fail('calling worktree not found')

  const outcome = await runMamaCommand(
    {
      workspaceId: callerId,
      projectSlug: caller.projectSlug,
      // Only when the caller actually declares a tool yaac knows: one running
      // something else says nothing about what a spawned workspace should
      // run, and a guess would outrank the server's configured default.
      ...(caller.declaredTool !== undefined ? { tool: caller.declaredTool } : {}),
    },
    { command: req.command, args: req.args ?? {}, body: req.body ?? '' },
  )

  return outcome.ok
    ? { requestId: req.requestId, ok: true, output: outcome.output }
    : fail(outcome.error)
}
