/**
 * Reconcile step that keeps one prewarmed spare per active project, warmed
 * with the project's default create settings. The pure `computePrewarmPlan`
 * decides; this lists pods, finds spares in an outdated agent mode or zone, and
 * spawns (`createWorkspace({ prewarm: true })`) or reaps
 * (`cleanupWorkspace`). It also keeps each spare on its base branch's
 * latest tip (`refreshSpares`).
 */
import crypto from 'node:crypto'
import type { RuntimeSnapshot } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspace, deleteWorkspaceState } from './cleanup'
import { createWorkspace, resolveCreate } from './create'
import { listProvisioning } from './provisioning'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
  reaping,
  refreshing,
  spareHeads,
  type PrewarmReapTarget,
} from './prewarm'
import { rebranchSpare } from './spare-pool'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { deleteSpareWorkspaceRow, getTimeZone, getWorkspaceRow, listProjectRows, type WorkspaceRow } from '#db'
import { serverLog } from '#log'
import { repoDir } from '@yaac/shared/project-paths'
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
    refreshing: new Set(refreshing.keys()),
    provisioning: new Set(listProvisioning().filter((e) => e.error === undefined).map((e) => e.projectId)),
    stale: await staleSpares(pods),
  })

  for (const target of toReap) reapSpare(target)

  for (const spawn of toSpawn) {
    // Recorded before any await so a concurrent tick sees it.
    const workspaceId = crypto.randomUUID()
    inFlight.set(workspaceId, spawn.projectId)
    void spawnSpare(spawn.projectId, workspaceId)
  }

  const reaped = new Set(toReap.map((t) => t.jobName))
  await refreshSpares(pods.filter((p) => p.prewarmed && p.running && !reaped.has(p.jobName)))
}

/**
 * Tear a spare down. No workspace sweep collects a spare's state, so it is
 * deleted here. Uses the awaited teardown so the checkout is removed only
 * once the pod is really gone. Each step runs only if the previous
 * succeeded; the flagged row goes last, so the orphan sweep can still
 * recognize and retry what is left. Not awaited, so a slow teardown does
 * not stall the tick.
 */
function reapSpare(target: PrewarmReapTarget): void {
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

/**
 * Move each spare whose base branch has a new tip up to it, in the
 * background (`rebranchSpare`: reset, init windows, agent restart), so a
 * claim finds it current instead of doing that work while the user waits.
 * The tip is read from the server's clone, which `origin-refresh` and every
 * create keep fetched. A spare left half-moved by a failure is reaped.
 */
async function refreshSpares(spares: RuntimeHandle[]): Promise<void> {
  const runtime = workspaceDriver()
  const listed = new Set(spares.map((p) => p.workspaceId))
  for (const id of spareHeads.keys()) if (!listed.has(id)) spareHeads.delete(id)
  const busy = (p: RuntimeHandle): boolean => claiming.has(p.jobName) || refreshing.has(p.jobName)
    || reaping.has(p.workspaceId) || inFlight.has(p.workspaceId)
  await Promise.all(spares.map(async (spare) => {
    if (busy(spare)) return
    let target: { branch: string; tip: string; row: WorkspaceRow }
    try {
      const row = await getWorkspaceRow(spare.projectId, spare.workspaceId)
      if (!row) return
      const repo = repoDir(spare.projectId)
      const branch = row.baseBranch ?? await getDefaultBranch(repo)
      target = { branch, tip: await resolveRemoteRef(repo, branch), row }
    } catch (err) {
      serverLog(`[prewarm] reading spare ${spare.workspaceId}'s base failed: ${String(err)}`)
      return
    }
    // A claim may have taken it during the reads.
    if (spareHeads.get(spare.workspaceId) === target.tip || busy(spare)) return
    let changed = false
    const refresh = (async () => {
      await runtime.awaitAgentTransport(spare.jobName, { timeoutMs: 10_000 })
      const { workspaceDir } = runtime.workspacePaths(spare.jobName)
      const head = (await runtime.exec(spare.jobName, `git -C ${workspaceDir} rev-parse HEAD`)).stdout.trim()
      if (head !== target.tip) {
        changed = true
        const { row } = target
        await rebranchSpare(spare, target.branch, target.tip, {
          tool: spare.tool,
          ...(row.model !== undefined ? { model: row.model } : {}),
          permissionMode: row.permissionMode,
          ...(row.effort !== undefined ? { effort: row.effort } : {}),
          mode: row.mode ?? spare.mode,
        })
      }
      spareHeads.set(spare.workspaceId, target.tip)
    })().catch((err: unknown) => {
      serverLog(`[prewarm] refreshing spare ${spare.workspaceId} failed: ${String(err)}`)
      if (changed) reapSpare(spare)
    }).finally(() => { refreshing.delete(spare.jobName) })
    refreshing.set(spare.jobName, refresh)
  }))
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
