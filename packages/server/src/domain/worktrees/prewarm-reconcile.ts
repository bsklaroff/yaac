/**
 * Reconcile step that keeps the prewarmed-worktree pool at its target:
 * one spare per active project, warmed as that project's untouched create
 * (a claim that asks for something else retools it). Spawns spares via
 * `createWorktree({ prewarm: true })` and reaps excess / idle ones — and ones
 * in an agent mode the project no longer creates in — via `cleanupWorktree`.
 * The decision is the pure `computePrewarmPlan`; this wrapper just lists pods,
 * reads what they were warmed as, and drives the side effects.
 */
import { worktreeDriver } from '#drivers/driver'
import type { RuntimeSnapshot } from '#drivers/contract'
import { cleanupWorktree, deleteWorktreeState } from './cleanup'
import { createWorktree, resolveCreate } from './create'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
} from './prewarm'
import { deleteSpareWorktreeRow, getWorktreeRow, listProjectRows } from '#db'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Fire a prewarm spawn, decrementing the in-flight counter when it settles.
 *
 * Warmed as the project's untouched create — what the create form would
 * submit if opened and confirmed, agent mode included, since the webapp is
 * who claims spares — so the usual claim runs the agent on as booted.
 * Resolved at spawn time, so a spare always reflects the latest choice.
 */
async function spawnSpare(projectSlug: string): Promise<void> {
  try {
    const setup = await resolveCreate(projectSlug, {}, { modeFromMemory: true })
    await createWorktree(projectSlug, { ...setup, prewarm: true })
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
export async function reconcilePrewarmPool(snapshot?: RuntimeSnapshot): Promise<void> {
  const poolSize = env.prewarmPoolSize
  if (poolSize === 0) return

  let pods
  try {
    pods = await (snapshot ?? worktreeDriver().snapshot()).workspaces()
  } catch {
    return
  }

  const { toSpawn, toReap } = computePrewarmPlan(
    pods, poolSize, inFlight, claiming, await staleModeSpares(pods),
  )

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
    void spawnSpare(spawn.projectSlug)
  }
}

/**
 * The spares warmed in a different agent mode than their project now creates
 * in — which no claim from the webapp can take, since the mode is fixed into
 * the pod at warm time. A spare whose row names no mode predates the column
 * and counts too; the pool replaces it once.
 *
 * Unreadable rows answer "not stale": reaping on a failed read would churn a
 * pod over a hiccup, and the next pass asks again.
 */
async function staleModeSpares(pods: RuntimeHandle[]): Promise<Set<string>> {
  const spares = pods.filter((p) => p.prewarmed && p.projectSlug && !claiming.has(p.jobName))
  if (spares.length === 0) return new Set()
  let projects
  try {
    projects = await listProjectRows()
  } catch {
    return new Set()
  }
  const wanted = new Map(projects.map((p) =>
    [p.slug, p.createDefaults[p.lastTool ?? 'claude']?.mode ?? 'tui']))
  const stale = new Set<string>()
  await Promise.all(spares.map(async (p) => {
    const row = await getWorktreeRow(p.projectSlug, p.workspaceId).catch(() => null)
    const want = wanted.get(p.projectSlug)
    if (row && want !== undefined && row.mode !== want) stale.add(p.jobName)
  }))
  return stale
}
