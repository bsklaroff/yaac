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
  type PrewarmReapTarget,
} from './prewarm'
import { deleteSpareWorktreeRow } from '#db'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { AgentTool } from '@yaac/shared/types'

/** Fire a prewarm spawn, decrementing the in-flight counter when it settles. */
async function spawnSpare(projectSlug: string, tool: AgentTool): Promise<void> {
  try {
    await createWorktree(projectSlug, { tool, prewarm: true })
  } catch (err) {
    serverLog(`[prewarm] spawn for ${projectSlug} failed: ${String(err)}`)
  } finally {
    const n = (inFlight.get(projectSlug) ?? 1) - 1
    if (n <= 0) inFlight.delete(projectSlug)
    else inFlight.set(projectSlug, n)
  }
}

/**
 * Tear one spare down, all the way to its row.
 *
 * A spare that is reaped unclaimed never became a worktree, so no worktree
 * sweep would ever collect its checkout or its git admin dir — its row is
 * flagged `spare` and filtered out of every listing.
 *
 * The AWAITED teardown, not the detached one: the detached variant resolves
 * before its `kubectl delete job` has even started, so removing the checkout
 * off the back of it would race a pod still mounting /workspace — and a
 * crash in that window would leave a claimable labeled spare whose checkout
 * is gone. `cleanupWorktree` returns only once the Job and its pod are
 * really gone, and says so: a delete that timed out with the pod still
 * terminating resolves false, and then the bytes stay put for the startup
 * sweep rather than being pulled out from under it.
 *
 * The row goes last, and only once the bytes are actually gone: while it
 * survives, the spare flag is what tells the startup sweep this checkout was
 * never a worktree, so dropping it over a failed rm would strand whatever
 * the teardown left. `deleteSpareWorktreeRow` is guarded on the flag, so it
 * can only ever take the row it was warmed with.
 */
async function reapSpare(target: PrewarmReapTarget): Promise<void> {
  const podGone = await cleanupWorktree(target)
  if (!podGone) return
  const removed = await deleteWorktreeState(target.projectSlug, target.worktreeId)
  if (removed) await deleteSpareWorktreeRow(target.projectSlug, target.worktreeId)
}

/**
 * Drop every spare a project is holding, and wait for them to be gone.
 *
 * For the one caller that has just made the pool's spares WRONG rather than
 * merely surplus: a spare is a fully-provisioned worktree whose image was
 * resolved when it was warmed, so after `yaac project rebuild` the pool
 * still holds pre-rebuild bytes. Nothing else notices — the planner reaps
 * only excess and idle spares, and a claim never looks at the image — so the
 * very next create would hand the user the stale agent CLIs the rebuild was
 * run to replace. The pool refills itself on the reconciler's next tick,
 * through the ordinary create path, which resolves the new image.
 *
 * Awaited, unlike the tick's own reaping, because that is the whole point:
 * the caller is telling a user its work is done, and a spare still standing
 * when the next create runs is the failure this prevents. A spare mid-claim
 * is left alone — it belongs to a create already in flight, which is the
 * same exclusion the planner makes.
 *
 * Best-effort per spare: one that will not tear down is logged and skipped
 * rather than failing the caller, whose own work has already succeeded.
 * Answers how many were taken.
 */
export async function reapProjectSpares(projectSlug: string): Promise<number> {
  let pods
  try {
    pods = await worktreeDriver().snapshot().workspaces()
  } catch {
    return 0
  }

  const targets: PrewarmReapTarget[] = pods
    .filter((p) => p.prewarmed && p.projectSlug === projectSlug && !claiming.has(p.jobName))
    .map((p) => ({ jobName: p.jobName, projectSlug: p.projectSlug, worktreeId: p.workspaceId }))

  const taken = await Promise.all(targets.map((t) =>
    reapSpare(t).then(() => true).catch((err: unknown) => {
      serverLog(`[prewarm] reaping spare ${t.jobName} after rebuild failed: ${String(err)}`)
      return false
    })))
  return taken.filter(Boolean).length
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
    // Not awaited by the tick, so a slow teardown never stalls the pool; a
    // failure here is collected by the startup sweep instead, since once the
    // pod is gone the planner (which sees only pods) can never retry it.
    void reapSpare(target).catch(() => { /* swept at startup — see gcOrphanWorktreeState */ })
  }

  for (const spawn of toSpawn) {
    // Bump in-flight BEFORE awaiting anything so a concurrent tick sees it.
    inFlight.set(spawn.projectSlug, (inFlight.get(spawn.projectSlug) ?? 0) + 1)
    void spawnSpare(spawn.projectSlug, spawn.tool)
  }
}
