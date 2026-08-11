/**
 * Reconcile step that drains in-worktree `yaac-spawn` requests: the egress
 * proxy holds each worktree's `POST http://yaac.internal/spawn` open in an
 * in-memory queue; this step takes them off that queue over the control API,
 * resolves who called from the pod labels, hands each one to `decideSpawn`,
 * and posts the answers back so the proxy can release the waiting pods.
 *
 * A drain is a claim: a crash between drain and report loses the fire (the
 * pod's request 504s at the proxy TTL), never doubles it.
 *
 * What a request MEANS is deliberately not here but in `decideSpawn`: which
 * tool the new worktree runs, how many a caller may have in flight, what id
 * it gets and what sidebar row it provisions under are policy — the drain's
 * whole contribution is the queue and the caller's labels
 * (docs/layered-server.md).
 */
import {
  proxyClient,
  pendingSpawnWorktreeId,
  type PendingSpawn,
  type SpawnResultWire,
} from '#runtime/k8s/egress'
import { worktreeRuntime } from '#runtime/driver'
import type { RuntimeHandle, RuntimeSnapshot } from '#runtime/contract'
import { decideSpawn } from './spawn-policy'
import { serverLog } from '#log'

export interface SpawnReconcileDeps {
  attachIfRunningFn?: () => Promise<boolean>
  fetchPendingFn?: () => Promise<PendingSpawn[]>
  postResultsFn?: (results: SpawnResultWire[]) => Promise<void>
  listWorkspacesFn?: () => Promise<RuntimeHandle[]>
}

/**
 * Drain queued spawn requests from the proxy and answer each one.
 * `snapshot` keeps the caller lookup on the pass's shared cluster view.
 */
export async function reconcileSpawnRequests(
  deps: SpawnReconcileDeps = {},
  snapshot?: RuntimeSnapshot,
): Promise<void> {
  try {
    // attachIfRunning, not ensureRunning: this step must never bootstrap the
    // proxy (it deploys lazily on the first worktree create). No proxy → no
    // worktrees → nothing queued.
    if (!(await (deps.attachIfRunningFn ?? (() => proxyClient.attachIfRunning()))())) return
    const pending = await (deps.fetchPendingFn ?? (() => proxyClient.fetchPendingSpawns()))()
    if (pending.length === 0) return
    // One pod listing per drain, shared by every request in the batch — the
    // informer cache when it is healthy, otherwise a single kubectl list. A
    // burst at the proxy's queue cap must not fan out into a fork per request.
    const listPods = deps.listWorkspacesFn
      ?? (() => (snapshot ?? worktreeRuntime().snapshot()).workspaces())
    let pods: Promise<RuntimeHandle[]> | undefined
    const drainDeps: SpawnReconcileDeps = { ...deps, listWorkspacesFn: () => (pods ??= listPods()) }
    const results = await Promise.all(pending.map((req) => reportSpawnRequest(req, drainDeps)))
    await (deps.postResultsFn ?? ((r: SpawnResultWire[]) => proxyClient.postSpawnResults(r)))(results)
  } catch (err) {
    serverLog(`[spawn] reconcile failed: ${String(err)}`)
  }
}

/**
 * Answer one spawn request: resolve the caller's project and tool from its
 * pod labels, hand it to the spawn policy, and relay the decision back to
 * the proxy.
 *
 * The caller lookup is the only judgement made here, and it is a substrate
 * one — a request from a worktree no pod matches cannot be attributed to a
 * project, so there is nothing to report.
 */
async function reportSpawnRequest(
  req: PendingSpawn,
  deps: SpawnReconcileDeps = {},
): Promise<SpawnResultWire> {
  const fail = (error: string): SpawnResultWire => ({ requestId: req.requestId, ok: false, error })

  // Under either name: a proxy predating the rename sends `sessionId`.
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
