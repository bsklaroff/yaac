/**
 * Reconcile step that drains pending `yaac-mama` requests from the runtime,
 * attributes each to its calling workspace, runs it through
 * `runMamaCommand`, and reports the answers back. A crash mid-drain loses a
 * request (it times out) rather than running it twice.
 *
 * This pull transport is for pods, whose requests the egress proxy holds.
 * Containerless workspaces post to `/workspace/mama` directly.
 */
import { workspaceDriver } from '#drivers/driver'
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
      ?? (() => workspaceDriver().pendingMamaRequests()))()
    if (pending.length === 0) return
    // One workspace listing per drain, shared by every request.
    const listPods = deps.listWorkspacesFn
      ?? (() => (snapshot ?? workspaceDriver().snapshot()).workspaces())
    let pods: Promise<RuntimeHandle[]> | undefined
    const drainDeps: MamaReconcileDeps = {
      ...deps,
      listWorkspacesFn: () => (pods ??= listPods()),
    }
    const results = await Promise.all(pending.map((req) => reportMamaRequest(req, drainDeps)))
    await (deps.postResultsFn
      ?? ((r: MamaResultWire[]) => workspaceDriver().resolveMamaRequests(r)))(results)
  } catch (err) {
    serverLog(`[mama] reconcile failed: ${String(err)}`)
  }
}

/**
 * Answer one request, attributing it via the live workspace listing. A
 * request from an unknown workspace fails.
 */
async function reportMamaRequest(
  req: PendingMamaRequest,
  deps: MamaReconcileDeps = {},
): Promise<MamaResultWire> {
  const fail = (error: string): MamaResultWire => ({ requestId: req.requestId, ok: false, error })

  // From the wire, so it may be missing despite the type.
  const callerId = req.workspaceId
  if (!callerId) return fail('request names no calling workspace')

  let caller: RuntimeHandle | undefined
  try {
    const pods = await (deps.listWorkspacesFn
      ?? (() => workspaceDriver().snapshot().workspaces()))()
    caller = pods.find((p) => p.workspaceId === callerId)
  } catch (err) {
    return fail(`cannot resolve calling workspace: ${String(err)}`)
  }
  if (!caller) return fail('calling workspace not found')

  const outcome = await runMamaCommand(
    {
      workspaceId: callerId,
      projectSlug: caller.projectSlug,
      // Only a known declared tool; a guess would override the default.
      ...(caller.declaredTool !== undefined ? { tool: caller.declaredTool } : {}),
    },
    { command: req.command, args: req.args ?? {}, body: req.body ?? '' },
  )

  return outcome.ok
    ? { requestId: req.requestId, ok: true, output: outcome.output }
    : fail(outcome.error)
}
