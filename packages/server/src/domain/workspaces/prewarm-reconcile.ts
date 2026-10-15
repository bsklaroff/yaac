/**
 * Reconcile step that keeps one prewarmed spare per active project, warmed
 * with the project's default create settings. The pure `computePrewarmPlan`
 * decides; this lists pods, finds spares in an outdated agent mode or zone
 * (or warmed before a server restart), and spawns
 * (`createWorkspace({ prewarm: true })`) or reaps (`reapSpare`). It also
 * keeps each spare on its base branch's latest tip (`refreshSpares`).
 */
import crypto from 'node:crypto'
import type { RuntimeSnapshot } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { createWorkspace, resolveCreate } from './create'
import { listProvisioning } from './provisioning'
import {
  claiming,
  computePrewarmPlan,
  inFlight,
  reapSpare,
  reaping,
  refreshing,
  spareHeads,
  spareSettings,
} from './prewarm'
import { rebranchSpare } from './spare-pool'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { getTimeZone, listProjectRows } from '#db'
import { serverLog } from '#lib/log'
import { repoDir } from '@yaac/shared/project-paths'
import { DEFAULT_AGENT_MODE } from '@yaac/shared/types'
import { env } from '@yaac/shared/env'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Spawn a spare under `workspaceId` with what the create form would submit
 * by default, then drop it from `inFlight`. A failed create has already torn
 * its spare down.
 */
async function spawnSpare(projectId: string, workspaceId: string): Promise<void> {
  try {
    const setup = await resolveCreate(projectId, {})
    await createWorkspace(projectId, { ...setup, prewarm: true, workspaceId })
  } catch (err) {
    spareSettings.delete(workspaceId)
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
    const warmed = spareSettings.get(spare.workspaceId)
    if (!warmed) return
    let target: { branch: string; tip: string }
    try {
      const repo = repoDir(spare.projectId)
      const branch = warmed.baseBranch ?? await getDefaultBranch(repo)
      target = { branch, tip: await resolveRemoteRef(repo, branch) }
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
      // Empty for a spare warmed on an empty repo, so it moves once origin
      // gets its first branch.
      const head = (await runtime.exec(spare.jobName, `git -C ${workspaceDir} rev-parse -q --verify HEAD || true`))
        .stdout.trim()
      if (head !== target.tip) {
        changed = true
        await rebranchSpare(spare, target.branch, target.tip, {
          tool: spare.tool,
          ...(warmed.model !== undefined ? { model: warmed.model } : {}),
          permissionMode: warmed.permissionMode,
          ...(warmed.effort !== undefined ? { effort: warmed.effort } : {}),
          mode: warmed.mode,
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
 * time, so no claim takes them. So are spares whose warm-time settings this
 * process never recorded (warmed before it started), which no claim can
 * match.
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
  for (const p of spares) {
    const warmed = spareSettings.get(p.workspaceId)
    const want = wanted.get(p.projectId)
    if (!warmed || (want !== undefined && (warmed.mode !== want.mode || warmed.timeZone !== want.timeZone))) {
      stale.add(p.jobName)
    }
  }
  return stale
}
