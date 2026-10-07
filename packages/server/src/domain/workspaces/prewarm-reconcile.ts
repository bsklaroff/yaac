/**
 * Reconcile step that keeps one prewarmed spare per active project, warmed
 * with the project's default create settings. The pure `computePrewarmPlan`
 * decides; this lists pods, finds spares in an outdated agent mode or zone, and
 * spawns (`createWorkspace({ prewarm: true })`) or reaps
 * (`cleanupWorkspace`).
 */
import crypto from 'node:crypto'
import type { RuntimeSnapshot } from '#drivers/contract'
import { cleanupWorkspace, deleteWorkspaceState } from './cleanup'
import { createWorkspace, resolveCreate } from './create'
import { listProvisioning } from './provisioning'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
  reaping,
} from './prewarm'
import { deleteSpareWorkspaceRow, getTimeZone, getWorkspaceRow, listProjectRows } from '#db'
import { serverLog } from '#log'
import { DEFAULT_AGENT_MODE } from '@yaac/shared/types'
import { env } from '@yaac/shared/env'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Spawn a spare under `workspaceId` with what the create form would submit
 * by default, then drop it from `inFlight`.
 */
async function spawnSpare(projectId: string, workspaceId: string): Promise<void> {
  try {
    const setup = await resolveCreate(projectId, {})
    await createWorkspace(projectId, { ...setup, prewarm: true, workspaceId })
  } catch (err) {
    serverLog(`[prewarm] spawn for ${projectId} failed: ${String(err)}`)
  } finally {
    inFlight.delete(workspaceId)
  }
}

/** Reconcile the prewarm pool once. No-op when `YAAC_PREWARM_POOL_SIZE=0`. */
export async function reconcilePrewarmPool(view: RuntimeSnapshot): Promise<void> {
  const poolSize = env.prewarmPoolSize
  if (poolSize === 0) return

  // A spare already being reaped is gone as far as the pool is concerned.
  const pods = (await view.workspaces()).filter((p) => !reaping.has(p.workspaceId))

  const { toSpawn, toReap } = computePrewarmPlan(pods, poolSize, {
    inFlight,
    claiming,
    provisioning: new Set(listProvisioning().filter((e) => e.error === undefined).map((e) => e.projectId)),
    stale: await staleSpares(pods),
  })

  for (const target of toReap) {
    // No workspace sweep collects a spare's state, so delete it here. Uses
    // the awaited teardown so the checkout is removed only once the pod is
    // really gone. Each step runs only if the previous succeeded; the
    // flagged row goes last, so the orphan sweep can still recognize and
    // retry what is left. Not awaited, so a slow teardown does not stall the
    // tick.
    reaping.add(target.workspaceId)
    void cleanupWorkspace(target)
      .then((podGone) => podGone && deleteWorkspaceState(target.projectId, target.workspaceId))
      .then(async (removed) => {
        if (removed) await deleteSpareWorkspaceRow(target.projectId, target.workspaceId)
      })
      .catch((err: unknown) => {
        // gcOrphanSpares in cleanup.ts retries what is left.
        serverLog(`[prewarm] reaping spare ${target.workspaceId} failed: ${String(err)}`)
      })
      .finally(() => { reaping.delete(target.workspaceId) })
  }

  for (const spawn of toSpawn) {
    // Recorded before any await so a concurrent tick sees it.
    const workspaceId = crypto.randomUUID()
    inFlight.set(workspaceId, spawn.projectId)
    void spawnSpare(spawn.projectId, workspaceId)
  }
}

/**
 * Spares warmed in a different agent mode than their project now creates in,
 * or in a zone other than the user's current one. Both are fixed at warm
 * time, so no claim takes them. A row with no mode (written before the
 * column) counts as stale. An unreadable row is logged and counts as not
 * stale.
 */
async function staleSpares(pods: RuntimeHandle[]): Promise<Set<string>> {
  const spares = pods.filter((p) => p.prewarmed && p.projectId && !claiming.has(p.jobName))
  if (spares.length === 0) return new Set()
  const projects = await listProjectRows()
  const wanted = new Map(await Promise.all(projects.map(async (p) => [p.id, {
    mode: p.createDefaults[p.lastTool ?? 'claude']?.mode ?? DEFAULT_AGENT_MODE,
    timeZone: (await getTimeZone(p.owner)).timeZone ?? undefined,
  }] as const)))
  const stale = new Set<string>()
  await Promise.all(spares.map(async (p) => {
    const row = await getWorkspaceRow(p.projectId, p.workspaceId).catch((err: unknown) => {
      serverLog(`[prewarm] reading spare ${p.workspaceId} failed: ${String(err)}`)
      return null
    })
    const want = wanted.get(p.projectId)
    if (row && want !== undefined && (row.mode !== want.mode || row.timeZone !== want.timeZone)) stale.add(p.jobName)
  }))
  return stale
}
