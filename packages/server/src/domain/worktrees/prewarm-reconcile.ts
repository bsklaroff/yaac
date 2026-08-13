/**
 * Reconcile step that keeps the prewarmed-worktree pool at its target:
 * one spare per active project, booting the configured default tool (spares
 * are tool-agnostic — a claim for another tool retools them). Spawns spares
 * via `createWorktree({ prewarm: true })` and reaps excess / idle ones via
 * `cleanupWorktreeDetached`. The decision is the pure `computePrewarmPlan`;
 * this wrapper just lists pods and drives the side effects.
 */
import { worktreeDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import { cleanupWorktree, deleteWorktreeState } from './cleanup'
import { createWorktree } from './create'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
} from './prewarm'
import { deleteSpareWorktreeRow } from '#db'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { AgentTool } from '@yaac/shared/types'

/** Fire a prewarm spawn, decrementing the in-flight counter when it settles. */
async function spawnSpare(projectSlug: string, tool: AgentTool): Promise<void> {
  try {
    // Explicitly `bypass`, never the project's remembered posture: a spare is
    // claimed only by a create that resolves to `bypass` (routes/worktrees),
    // so warming one in anything else would build spares nothing can claim —
    // and `retoolSpare` respawns its agent in `bypass` regardless.
    await createWorktree(projectSlug, { tool, prewarm: true, permissionMode: 'bypass' })
  } catch (err) {
    serverLog(`[prewarm] spawn for ${projectSlug} failed: ${String(err)}`)
  } finally {
    const n = (inFlight.get(projectSlug) ?? 1) - 1
    if (n <= 0) inFlight.delete(projectSlug)
    else inFlight.set(projectSlug, n)
  }
}

/**
 * Reconcile the prewarm pool once. No-op when `YAAC_PREWARM_POOL_SIZE=0`.
 * Best-effort: a cluster hiccup just skips this tick.
 */
export async function reconcilePrewarmPool(
  // Which tool to warm spares with is a user preference — a row, resolved
  // once per pass and handed down so no substrate step reads one
  // (docs/layered-server.md).
  defaultTool: AgentTool,
  snapshot?: RuntimeSnapshot,
): Promise<void> {
  const poolSize = env.prewarmPoolSize
  if (poolSize === 0) return

  let pods
  try {
    pods = await (snapshot ?? worktreeDriver().snapshot()).workspaces()
  } catch {
    return
  }

  const { toSpawn, toReap } = computePrewarmPlan(pods, poolSize, defaultTool, inFlight, claiming)

  for (const target of toReap) {
    // A spare that is reaped unclaimed never became a worktree, so no
    // worktree sweep would ever collect its checkout or its git admin dir —
    // its row is flagged `spare` and filtered out of every listing.
    //
    // The AWAITED teardown, not the detached one: the detached variant
    // resolves before its `kubectl delete job` has even started, so removing
    // the checkout off the back of it would race a pod still mounting
    // /workspace — and a crash in that window would leave a claimable
    // labeled spare whose checkout is gone. `cleanupWorktree` returns only
    // once the Job and its pod are really gone, and says so: a delete that
    // timed out with the pod still terminating resolves false, and then the
    // bytes stay put for the startup sweep rather than being pulled out from
    // under it.
    //
    // Not awaited by the tick, so a slow teardown never stalls the pool; a
    // failure here is collected by the startup sweep instead, since once the
    // pod is gone the planner (which sees only pods) can never retry it.
    // The row goes last, and only once the bytes are actually gone: while it
    // survives, the spare flag is what tells the startup sweep this checkout
    // was never a worktree, so dropping it over a failed rm would strand
    // whatever the teardown left. `deleteSpareWorktreeRow` is guarded on the
    // flag, so it can only ever take the row it was warmed with.
    void cleanupWorktree(target)
      .then((podGone) => podGone && deleteWorktreeState(target.projectSlug, target.worktreeId))
      .then(async (removed) => {
        if (removed) await deleteSpareWorktreeRow(target.projectSlug, target.worktreeId)
      })
      .catch(() => { /* swept at startup — see gcOrphanWorktreeState */ })
  }

  for (const spawn of toSpawn) {
    // Bump in-flight BEFORE awaiting anything so a concurrent tick sees it.
    inFlight.set(spawn.projectSlug, (inFlight.get(spawn.projectSlug) ?? 0) + 1)
    void spawnSpare(spawn.projectSlug, spawn.tool)
  }
}
