/**
 * Reconcile step that keeps one prewarmed spare per active project. The
 * pure `computePrewarmPlan` decides; this lists pods, finds spares in an
 * outdated zone or image (or warmed before a server restart), and spawns
 * (`createWorkspace({ prewarm: true })`) or reaps (`reapSpare`). It also
 * keeps each spare's checkouts on their base branches' latest tips
 * (`refreshSpares`). Spares are warmed with what the project's last create
 * started with (`resolveStart`), since that is what the next is likeliest
 * to ask for.
 */
import crypto from 'node:crypto'
import type { RuntimeSnapshot } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { createWorkspace } from './create'
import { listProvisioning, settleSpare, spawningSpares } from './provisioning'
import {
  claiming,
  computePrewarmPlan,
  currentSpareImage,
  freeSpare,
  reapSpare,
  reaping,
  refreshing,
  spareHeads,
  spareMatches,
  spareSettings,
  type SpareSettings,
} from './prewarm'
import { resolveStart } from './checkouts'
import { rebranchSpare } from './spare-pool'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import path from 'node:path'
import { getProjectRow, getTimeZone, listProjectRows } from '#db'
import { serverLog } from '#lib/log'
import { repoDir } from '@yaac/shared/project-paths'
import { env } from '@yaac/shared/env'
import type { RuntimeHandle } from '#drivers/contract'

/**
 * Spawn a spare under `workspaceId`, then settle it out of
 * `spawningSpares`. A failed create has already torn its spare down.
 */
async function spawnSpare(projectId: string, workspaceId: string): Promise<void> {
  try {
    const project = await getProjectRow(projectId)
    if (!project) return
    await createWorkspace(projectId, { prewarm: true, workspaceId, start: resolveStart(project, {}) })
  } catch (err) {
    spareSettings.delete(workspaceId)
    serverLog(`[prewarm] spawn for ${projectId} failed: ${String(err)}`)
  } finally {
    settleSpare(workspaceId)
  }
}

/** Reconcile the prewarm pool once. No-op when `YAAC_PREWARM_POOL_SIZE=0`. */
export async function reconcilePrewarmPool(view: RuntimeSnapshot): Promise<void> {
  const poolSize = env.prewarmPoolSize
  if (poolSize === 0) return

  // A spare already being reaped is gone as far as the pool is concerned.
  const pods = (await view.workspaces()).filter((p) => !reaping.has(p.workspaceId))

  const { toSpawn, toReap } = computePrewarmPlan(pods, poolSize, {
    inFlight: spawningSpares,
    claiming,
    refreshing: new Set(refreshing.keys()),
    provisioning: new Set(listProvisioning().filter((e) => e.error === undefined).map((e) => e.projectId)),
    stale: await staleSpares(pods),
  })

  for (const target of toReap) reapSpare(target)

  for (const spawn of toSpawn) {
    // Recorded before any await so a concurrent tick sees it.
    const workspaceId = crypto.randomUUID()
    spawningSpares.set(workspaceId, spawn.projectId)
    void spawnSpare(spawn.projectId, workspaceId)
  }

  await refreshSpares(pods.filter((p) => p.prewarmed && p.running))
}

/**
 * Move each spare checkout whose base branch has a new tip up to it, in the
 * background (`rebranchSpare`), so a claim finds it current instead of
 * doing that work while the user waits. The tips are read from the main
 * clones, which `origin-refresh` and every create keep fetched. A spare
 * left half-moved by a failure is reaped.
 */
async function refreshSpares(spares: RuntimeHandle[]): Promise<void> {
  const runtime = workspaceDriver()
  const listed = new Set(spares.map((p) => p.workspaceId))
  for (const id of spareHeads.keys()) if (!listed.has(id)) spareHeads.delete(id)
  // `spares` is the pass's listing, which a claim or reap may have
  // overtaken, so this is asked again after every await.
  const free = (p: RuntimeHandle): SpareSettings | undefined =>
    refreshing.has(p.jobName) ? undefined : freeSpare(p)
  await Promise.all(spares.map(async (spare) => {
    const warmed = free(spare)
    if (!warmed) return
    let targets: Array<{ path: string; branch: string; tip: string }>
    try {
      targets = await Promise.all(warmed.repos.map(async (r) => {
        const repo = repoDir(r.repoId)
        const branch = r.baseBranch ?? await getDefaultBranch(repo)
        return { path: r.path, branch, tip: await resolveRemoteRef(repo, branch) }
      }))
    } catch (err) {
      serverLog(`[prewarm] reading spare ${spare.workspaceId}'s base failed: ${String(err)}`)
      return
    }
    const tips = targets.map((t) => t.tip).join(',')
    if (spareHeads.get(spare.workspaceId) === tips || free(spare) !== warmed) return
    let changed = false
    const refresh = (async () => {
      await runtime.awaitAgentTransport(spare.jobName, { timeoutMs: 10_000 })
      const { workspaceDir } = runtime.workspacePaths(spare.jobName)
      for (const target of targets) {
        const checkout = path.posix.join(workspaceDir, target.path)
        const head = (await runtime.exec(spare.jobName, `git -C ${checkout} rev-parse -q --verify HEAD || true`))
          .stdout.trim()
        if (head === target.tip) continue
        changed = true
        await rebranchSpare(spare, checkout, target.branch, target.tip)
      }
      spareHeads.set(spare.workspaceId, tips)
    })().catch((err: unknown) => {
      serverLog(`[prewarm] refreshing spare ${spare.workspaceId} failed: ${String(err)}`)
      if (changed) reapSpare(spare)
    }).finally(() => { refreshing.delete(spare.jobName) })
    refreshing.set(spare.jobName, refresh)
  }))
}

/**
 * Spares warmed in a zone other than the user's current one, on an image
 * other than the one the project now builds, or with other repos, folders
 * or cwd than its last create's. All are fixed at warm time, so no claim
 * like the last takes them. So are spares whose warm-time settings this process never
 * recorded (warmed before it started), which no claim can match. A project
 * whose image cannot be resolved keeps its spares, which a claim then
 * passes over.
 */
async function staleSpares(pods: RuntimeHandle[]): Promise<Set<string>> {
  const spares = pods.filter((p) => p.prewarmed && p.projectId)
  if (spares.length === 0) return new Set()
  const projects = (await listProjectRows()).filter((p) => spares.some((s) => s.projectId === p.id))
  const wanted = new Map(await Promise.all(projects.map(async (p) => [p.id, {
    start: resolveStart(p, {}),
    timeZone: (await getTimeZone(p.owner)).timeZone ?? undefined,
    image: await currentSpareImage(p).then((ref) => ({ ref }), (err: unknown) => {
      serverLog(`[prewarm] resolving ${p.id}'s image failed: ${String(err)}`)
      return undefined
    }),
  }] as const)))
  const stale = new Set<string>()
  for (const p of spares) {
    const warmed = spareSettings.get(p.workspaceId)
    const want = wanted.get(p.projectId)
    if (!warmed || (want !== undefined && (warmed.timeZone !== want.timeZone
      || !spareMatches(warmed, want.start)
      || (want.image !== undefined && warmed.image !== want.image.ref)))) {
      stale.add(p.jobName)
    }
  }
  return stale
}
