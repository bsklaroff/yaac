/**
 * Reconcile step that drains in-worktree `yaac-spawn` requests: the runtime
 * holds each waiting worktree's request until someone answers it; this step
 * takes them, resolves who called from the live workspace listing, hands
 * each one to `decideSpawn`, and reports the answers back so the callers
 * can be released.
 *
 * A drain is a claim: a crash between drain and report loses the fire (the
 * caller's request times out where it waits), never doubles it.
 *
 * What a request MEANS is deliberately not here but in `decideSpawn`: which
 * tool the new worktree runs, how many a caller may have in flight, what id
 * it gets and what sidebar row it provisions under are policy — the drain's
 * whole contribution is the queue and attributing each request to its
 * caller (docs/layered-server.md).
 */
import { worktreeRuntime } from '#runtime/driver'
import type { RuntimeHandle, RuntimeSnapshot } from '#runtime/contract'
import { decideSpawn } from './spawn-policy'
import { serverLog } from '#log'
import { pendingSpawnWorktreeId } from '@yaac/shared/types'
import type { PendingSpawn, SpawnResultWire } from '@yaac/shared/types'

export interface SpawnReconcileDeps {
  fetchPendingFn?: () => Promise<PendingSpawn[]>
  postResultsFn?: (results: SpawnResultWire[]) => Promise<void>
  listWorkspacesFn?: () => Promise<RuntimeHandle[]>
}

/**
 * Drain queued spawn requests from the runtime and answer each one.
 * `snapshot` keeps the caller lookup on the pass's shared runtime view.
 */
export async function reconcileSpawnRequests(
  deps: SpawnReconcileDeps = {},
  snapshot?: RuntimeSnapshot,
): Promise<void> {
  try {
    const pending = await (deps.fetchPendingFn ?? (() => worktreeRuntime().pendingSpawns()))()
    if (pending.length === 0) return
    // One workspace listing per drain, shared by every request in the batch.
    // A burst at the queue cap must not fan out into a listing per request.
    const listPods = deps.listWorkspacesFn
      ?? (() => (snapshot ?? worktreeRuntime().snapshot()).workspaces())
    let pods: Promise<RuntimeHandle[]> | undefined
    const drainDeps: SpawnReconcileDeps = { ...deps, listWorkspacesFn: () => (pods ??= listPods()) }
    const results = await Promise.all(pending.map((req) => reportSpawnRequest(req, drainDeps)))
    await (deps.postResultsFn
      ?? ((r: SpawnResultWire[]) => worktreeRuntime().resolveSpawns(r)))(results)
  } catch (err) {
    serverLog(`[spawn] reconcile failed: ${String(err)}`)
  }
}

/**
 * Answer one spawn request: resolve the caller's project and tool from the
 * live workspace listing, hand it to the spawn policy, and relay the
 * decision back.
 *
 * The caller lookup is the only judgement made here — a request from a
 * worktree the runtime does not report cannot be attributed to a project,
 * so there is nothing to report.
 */
async function reportSpawnRequest(
  req: PendingSpawn,
  deps: SpawnReconcileDeps = {},
): Promise<SpawnResultWire> {
  const fail = (error: string): SpawnResultWire => ({ requestId: req.requestId, ok: false, error })

  // Under either name: a proxy predating the rename sends `sessionId`
  // (see `pendingSpawnWorktreeId`).
  const callerId = pendingSpawnWorktreeId(req)
  if (!callerId) return fail('spawn request names no calling worktree')

  let caller: RuntimeHandle | undefined
  try {
    const pods = await (deps.listWorkspacesFn
      ?? (() => worktreeRuntime().snapshot().workspaces()))()
    caller = pods.find((p) => p.workspaceId === callerId)
  } catch (err) {
    return fail(`cannot resolve calling worktree: ${String(err)}`)
  }
  if (!caller) return fail('calling worktree not found')

  const decision = await decideSpawn({
    requestId: req.requestId,
    callerWorkspaceId: callerId,
    callerProjectSlug: caller.projectSlug,
    // Only when the caller actually declares a tool yaac knows: one running
    // something else says nothing about what the spawned workspace should
    // run, and a guess would outrank the server's configured default.
    ...(caller.declaredTool !== undefined ? { callerTool: caller.declaredTool } : {}),
    prompt: req.prompt,
    ...(req.tool !== undefined ? { tool: req.tool } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
  })

  return decision.ok
    // Both names: an old proxy completes the waiting pod from `sessionId`.
    ? {
        requestId: req.requestId,
        ok: true,
        worktreeId: decision.workspaceId,
        sessionId: decision.workspaceId,
      }
    : fail(decision.error)
}
