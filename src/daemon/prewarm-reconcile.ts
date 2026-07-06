/**
 * Background-loop step that keeps the prewarmed-session pool at its target:
 * one spare per active project, booting the configured default tool (spares
 * are tool-agnostic — a claim for another tool retools them). Spawns spares
 * via `createSession({ prewarm: true })` and reaps excess / idle ones via
 * `cleanupSessionDetached`. The decision is the pure `computePrewarmPlan`;
 * this wrapper just lists pods and drives the side effects.
 */
import { listSessionPods } from '@/lib/k8s/pods'
import { getDefaultTool } from '@/lib/project/preferences'
import { cleanupSessionDetached } from '@/lib/session/cleanup'
import { createSession } from '@/daemon/session-create'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
} from '@/daemon/prewarm'
import { daemonLog } from '@/daemon/log'
import { env } from '@/shared/env'
import type { AgentTool } from '@/shared/types'

/** Fire a prewarm spawn, decrementing the in-flight counter when it settles. */
async function spawnSpare(projectSlug: string, tool: AgentTool): Promise<void> {
  try {
    await createSession(projectSlug, { tool, prewarm: true })
  } catch (err) {
    daemonLog(`[prewarm] spawn for ${projectSlug} failed: ${String(err)}`)
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
export async function reconcilePrewarmPool(): Promise<void> {
  const poolSize = env.prewarmPoolSize
  if (poolSize === 0) return

  let pods
  try {
    pods = await listSessionPods()
  } catch {
    return
  }

  const defaultTool = (await getDefaultTool()) ?? 'claude'
  const { toSpawn, toReap } = computePrewarmPlan(pods, poolSize, defaultTool, inFlight, claiming)

  for (const target of toReap) {
    cleanupSessionDetached(target).catch(() => { /* best-effort; reaper retries */ })
  }

  for (const spawn of toSpawn) {
    // Bump in-flight BEFORE awaiting anything so a concurrent tick sees it.
    inFlight.set(spawn.projectSlug, (inFlight.get(spawn.projectSlug) ?? 0) + 1)
    void spawnSpare(spawn.projectSlug, spawn.tool)
  }
}
