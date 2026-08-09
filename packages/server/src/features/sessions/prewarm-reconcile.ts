/**
 * Reconcile step that keeps the prewarmed-session pool at its target:
 * one spare per active project, booting the configured default tool (spares
 * are tool-agnostic — a claim for another tool retools them). Spawns spares
 * via `createSession({ prewarm: true })` and reaps excess / idle ones via
 * `cleanupSessionDetached`. The decision is the pure `computePrewarmPlan`;
 * this wrapper just lists pods and drives the side effects.
 */
import { type TickSnapshot, listSessionPods } from '#platform/k8s'
import { cleanupSession, deleteWorktreeState } from './cleanup'
import { createSession } from './create'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
} from './prewarm'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { AgentTool } from '@yaac/shared/types'

/** Fire a prewarm spawn, decrementing the in-flight counter when it settles. */
async function spawnSpare(projectSlug: string, tool: AgentTool): Promise<void> {
  try {
    await createSession(projectSlug, { tool, prewarm: true })
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
  // Which tool to warm spares with is a user preference — a row, and so the
  // server's to resolve and hand down. A herd is told what to run, never
  // where the answer is kept (docs/plans/herd-split.md).
  defaultTool: AgentTool,
  snapshot?: TickSnapshot,
): Promise<void> {
  const poolSize = env.prewarmPoolSize
  if (poolSize === 0) return

  let pods
  try {
    pods = await (snapshot ? snapshot.pods() : listSessionPods())
  } catch {
    return
  }

  const { toSpawn, toReap } = computePrewarmPlan(pods, poolSize, defaultTool, inFlight, claiming)

  for (const target of toReap) {
    // A spare that is reaped unclaimed never became a worktree, so nothing
    // else would ever collect its checkout, its git admin dir or the herd's
    // document for it — there is no row to make any of it visible.
    //
    // The AWAITED teardown, not the detached one: the detached variant
    // resolves before its `kubectl delete job` has even started, so removing
    // the checkout off the back of it would race a pod still mounting
    // /workspace — and a crash in that window would leave a claimable
    // labeled spare whose checkout is gone. `cleanupSession` returns only
    // once the Job is deleted.
    //
    // Not awaited by the tick, so a slow teardown never stalls the pool; a
    // failure here is collected by the startup sweep instead, since once the
    // pod is gone the planner (which sees only pods) can never retry it.
    void cleanupSession(target)
      .then(() => deleteWorktreeState(target.projectSlug, target.sessionId))
      .catch(() => { /* swept at startup — see gcOrphanWorktreeState */ })
  }

  for (const spawn of toSpawn) {
    // Bump in-flight BEFORE awaiting anything so a concurrent tick sees it.
    inFlight.set(spawn.projectSlug, (inFlight.get(spawn.projectSlug) ?? 0) + 1)
    void spawnSpare(spawn.projectSlug, spawn.tool)
  }
}
