/**
 * The prewarmed pool (docs/generic-workspace-pods.md "Pool policy"): spare
 * workspace pods that belong to no project, one pool per image and scratch
 * size, and the take a start makes before it names its workspace, so the
 * spare's id becomes the workspace's.
 *
 * The rule is the ready trees' rule: one pool, of `YAAC_PREWARM_POOL_SIZE`
 * spares (default 1, 0 turns pools off), for each image and scratch size a
 * workspace running now uses, or one that stopped less than a day ago used.
 * "Used" means what its project would launch now, so a spare on an image a
 * Dockerfile edit has replaced is reaped rather than kept for a claim that
 * never comes. Spares do not outlive the server: one made before this
 * process started carries another build's programs, and is reaped.
 *
 * The server is a single process, so module-level state is enough mutual
 * exclusion.
 */
import crypto from 'node:crypto'
import { workspaceDriver } from '#drivers/driver'
import type { SpareUnit } from '#drivers/contract'
import { findWorkspaceRow, getProjectRow, listRecentWorkspaces } from '#db'
import { spareImageTag } from '#domain/images'
import { env } from '@yaac/shared/env'
import { serverLog } from '#lib/log'
import { deleteWorkspaceState } from './cleanup'
import { WORKSPACE_RESOURCES } from './create'
import { stageHelpers } from './workspace-bin'

/** How long a stopped workspace keeps its pool. */
const RECENT_MS = 24 * 60 * 60_000
/** How long a spare asked for counts toward its pool before its pod lists. */
const WARM_GRACE_MS = 60_000
const GiB = 1024 ** 3

/** One pool: the image and scratch size its spares are for. */
export interface Pool {
  image: string
  scratchBytes: number
}

const poolKey = (p: Pool): string => `${p.image} ${String(p.scratchBytes)}`

/** Spares asked for and not listed yet, by a token of their own. */
const warming = new Map<string, { key: string; at: number; id?: string }>()
/** Starts between taking a spare and opening their windows. The pool
 *  refills only when none is under way: a pod starting beside a claim slows
 *  the claim's exec by about 100 ms. */
let claimsUnderWay = 0
/** When this process started, to the second, as a pod's creation time is
 *  recorded, so a spare it made in its first second counts as its own. */
const startedAt = Math.floor(Date.now() / 1000) * 1000
/** Older servers' spares being reaped, so a pass starts no second reap. */
const reapingOlder = new Set<string>()

/** Test helper: reset the pool's in-memory state. */
export function clearPrewarmStateForTests(): void {
  warming.clear()
  reapingOlder.clear()
  claimsUnderWay = 0
}

/**
 * Pure planner: which pools to warm a spare for, and which spares to reap.
 * A spare that ended, one a dead server took and never launched, one made
 * before `since`, and one no wanted pool is for are reaped; a pool with
 * more than `poolSize` loses its oldest; one with fewer, counting spares
 * still being asked for, gets more. A spare still up is reaped only while
 * it is a spare (`ifSpare`), so a start that takes it meanwhile keeps it.
 * A pending one, whose pool is not known yet, and an older server's are
 * left out of the plan.
 */
export function computePoolPlan(
  spares: SpareUnit[],
  wanted: Pool[],
  poolSize: number,
  inFlight: ReadonlyMap<string, number>,
  since: number,
): { toWarm: Pool[]; toReap: Array<{ workspaceId: string; ifSpare: boolean }> } {
  const want = new Map(wanted.map((p) => [poolKey(p), p]))
  const toReap: Array<{ workspaceId: string; ifSpare: boolean }> = []
  const reap = (s: SpareUnit): void => { toReap.push({ workspaceId: s.workspaceId, ifSpare: !s.failed && !s.orphaned }) }
  const live = new Map<string, SpareUnit[]>()
  for (const s of spares) {
    if (s.pending === true || s.projectId !== undefined) continue
    const key = poolKey(s)
    if (s.failed || s.orphaned || s.createdAtMs < since || poolSize === 0 || !want.has(key)) {
      reap(s)
      continue
    }
    live.set(key, [...live.get(key) ?? [], s])
  }
  const toWarm: Pool[] = []
  for (const [key, pool] of want) {
    const have = (live.get(key) ?? []).sort((a, b) => a.createdAtMs - b.createdAtMs)
    if (have.length > poolSize) have.slice(0, have.length - poolSize).forEach(reap)
    for (let n = have.length + (inFlight.get(key) ?? 0); n < poolSize; n++) toWarm.push(pool)
  }
  return { toWarm, toReap }
}

/** What a start of the project on `imageId`, else the image it last chose
 *  or its default, would take a spare of: what a create naming no image
 *  launches. Null while that image has nothing built. */
async function poolOf(projectId: string, imageId?: string): Promise<Pool | null> {
  const row = await getProjectRow(projectId)
  if (!row) return null
  const tag = await spareImageTag(projectId, imageId)
  if (tag === null) return null
  return { image: workspaceDriver().imageRef(tag), scratchBytes: row.scratchDirs.sizeGiB * GiB }
}

/** The pools wanted now: one for each project with a workspace running, or
 *  stopped less than a day ago. */
async function wantedPools(): Promise<Pool[]> {
  const recent = await listRecentWorkspaces(new Date(Date.now() - RECENT_MS))
  const pools = await Promise.all([...new Set(recent.map((w) => w.projectId))].map((id) => poolOf(id).catch((err: unknown) => {
    serverLog(`[prewarm] resolving project ${id}'s image failed: ${String(err)}`)
    return null
  })))
  return [...new Map(pools.flatMap((p) => (p === null ? [] : [[poolKey(p), p] as const]))).values()]
}

/** Reconcile the pool once: reap what no pool wants, warm what one lacks. */
export async function reconcilePrewarmPool(): Promise<void> {
  const runtime = workspaceDriver()
  const poolSize = env.prewarmPoolSize
  const [spares, wanted] = await Promise.all([runtime.listSpares(), poolSize === 0 ? [] : wantedPools()])
  for (const s of spares) if (s.projectId !== undefined) reapOlderSpare(s.workspaceId, s.projectId)
  // A pending spare is still being asked for, so it stays in flight.
  const listed = new Set(spares.flatMap((s) => (s.pending === true ? [] : [s.workspaceId])))
  const now = Date.now()
  const inFlight = new Map<string, number>()
  for (const [token, w] of warming) {
    if ((w.id !== undefined && listed.has(w.id)) || now - w.at > WARM_GRACE_MS) warming.delete(token)
    else inFlight.set(w.key, (inFlight.get(w.key) ?? 0) + 1)
  }
  const { toWarm, toReap } = computePoolPlan(spares, wanted, poolSize, inFlight, startedAt)
  for (const { workspaceId, ifSpare } of toReap) {
    void runtime.reapSpare(workspaceId, { ifSpare })
      .catch((err: unknown) => serverLog(`[prewarm] reaping spare ${workspaceId} failed: ${String(err)}`))
  }
  if (claimsUnderWay > 0 || toWarm.length === 0) return
  // A spare mounts this build's helpers from its creation.
  await stageHelpers()
  for (const pool of toWarm) {
    const token = crypto.randomUUID()
    const entry: { key: string; at: number; id?: string } = { key: poolKey(pool), at: Date.now() }
    warming.set(token, entry)
    void runtime.warmSpare({ ...pool, resources: WORKSPACE_RESOURCES })
      .then((id) => { entry.id = id })
      .catch((err: unknown) => {
        warming.delete(token)
        serverLog(`[prewarm] warming a spare of ${pool.image} failed: ${String(err)}`)
      })
  }
}

/** How long reaping an older server's spare retries its files after its
 *  Job is deleted: past the time its pod takes to go. */
const OLDER_SPARE_FILES_MS = 90_000

/**
 * Reap a per-project spare an older server made (docs/legacy-compat-shims.md):
 * its Job, then its files, which hold the checkout it was warmed with. The
 * files are retried until the pod has gone, since a running pod holds some
 * open and a shared tier on NFS refuses to remove an open file. One with a
 * row was claimed after all, and is left alone.
 */
function reapOlderSpare(workspaceId: string, projectId: string): void {
  if (reapingOlder.has(workspaceId)) return
  reapingOlder.add(workspaceId)
  void (async () => {
    if (await findWorkspaceRow(workspaceId) !== undefined) return
    await workspaceDriver().reapSpare(workspaceId)
    const deadline = Date.now() + OLDER_SPARE_FILES_MS
    while (!await deleteWorkspaceState(projectId, workspaceId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000))
    }
  })()
    .catch((err: unknown) => serverLog(`[prewarm] reaping an older server's spare ${workspaceId} failed: ${String(err)}`))
    .finally(() => { reapingOlder.delete(workspaceId) })
}

/**
 * Take a spare for a start of `projectId` on `imageId` (the project's
 * last chosen or default when absent) and answer its id, which the start names its
 * workspace with, or undefined when none waits. While the take's start is
 * under way the pool does not refill; `done` ends that.
 */
export async function takeSpareFor(projectId: string, imageId: string | undefined): Promise<{ id: string; done: () => void } | undefined> {
  const runtime = workspaceDriver()
  if (runtime.kind === 'containerless' || env.prewarmPoolSize === 0) return undefined
  const pool = await poolOf(projectId, imageId).catch(() => null)
  if (pool === null) return undefined
  // One made before this process started carries another build's programs.
  const id = await runtime.takeSpare({ ...pool, madeSince: startedAt }).catch((err: unknown) => {
    serverLog(`[prewarm] taking a spare failed: ${String(err)}`)
    return undefined
  })
  if (id === undefined) return undefined
  claimsUnderWay++
  let ended = false
  return {
    id,
    done: () => {
      if (ended) return
      ended = true
      claimsUnderWay--
    },
  }
}
