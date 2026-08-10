/**
 * Reconcile step that drains in-worktree `yaac-spawn` requests: the egress
 * proxy holds each worktree's `POST http://yaac.internal/spawn` open in an
 * in-memory queue; this step takes them off that queue over the control API,
 * resolves who called from the pod labels, reports each one to the server,
 * and posts the answers back so the proxy can release the waiting pods.
 *
 * A drain is a claim: a crash between drain and report loses the fire (the
 * pod's request 504s at the proxy TTL), never doubles it.
 *
 * What a request MEANS is deliberately not here. Which tool the new workspace
 * runs, how many a caller may have in flight, what id it gets and what
 * sidebar row it provisions under are all the server's — a herd's whole
 * contribution is that the queue and the caller's labels are on its side of
 * the boundary (docs/plans/layered-server.md).
 */
import {
  proxyClient,
  pendingSpawnWorktreeId,
  type PendingSpawn,
  type SpawnResultWire,
} from '#features/egress'
import { type PodInfo, type TickSnapshot, listWorktreePods } from '#platform/k8s'
import { normalizeTool } from '#features/agents'
import { serverLink } from '#server-link'
import { AGENT_TOOLS } from '@yaac/shared/types'
import { serverLog } from '#log'

export interface SpawnReconcileDeps {
  attachIfRunningFn?: () => Promise<boolean>
  fetchPendingFn?: () => Promise<PendingSpawn[]>
  postResultsFn?: (results: SpawnResultWire[]) => Promise<void>
  listWorktreePodsFn?: () => Promise<PodInfo[]>
}

/**
 * Drain queued spawn requests from the proxy and answer each one.
 * `snapshot` keeps the caller lookup on the pass's shared cluster view.
 */
export async function reconcileSpawnRequests(
  deps: SpawnReconcileDeps = {},
  snapshot?: TickSnapshot,
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
    const listPods = deps.listWorktreePodsFn
      ?? (snapshot ? () => snapshot.pods() : listWorktreePods)
    let pods: Promise<PodInfo[]> | undefined
    const drainDeps: SpawnReconcileDeps = { ...deps, listWorktreePodsFn: () => (pods ??= listPods()) }
    const results = await Promise.all(pending.map((req) => reportSpawnRequest(req, drainDeps)))
    await (deps.postResultsFn ?? ((r: SpawnResultWire[]) => proxyClient.postSpawnResults(r)))(results)
  } catch (err) {
    serverLog(`[spawn] reconcile failed: ${String(err)}`)
  }
}

/**
 * Answer one spawn request: resolve the caller's project and tool from its
 * pod labels, report it, and relay the server's decision back to the proxy.
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

  let caller: PodInfo | undefined
  try {
    const pods = await (deps.listWorktreePodsFn ?? listWorktreePods)()
    caller = pods.find((p) => p.worktreeId === callerId)
  } catch (err) {
    return fail(`cannot resolve calling worktree: ${String(err)}`)
  }
  if (!caller) return fail('calling worktree not found')

  const decision = await serverLink().spawnRequested({
    requestId: req.requestId,
    callerWorkspaceId: callerId,
    callerProjectSlug: caller.projectSlug,
    // Only when the label is a tool yaac knows: a pod stamped with something
    // else says nothing about what the spawned workspace should run, and
    // reporting a guess would outrank the server's configured default.
    ...((AGENT_TOOLS as readonly string[]).includes(caller.tool)
      ? { callerTool: normalizeTool(caller.tool) }
      : {}),
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
