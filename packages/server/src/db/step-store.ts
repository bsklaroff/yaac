import { and, asc, eq, inArray, lt, max, ne, sql } from 'drizzle-orm'
import { getDb } from './client'
import { workspaceSteps } from './schema'
import { ServerError } from '@yaac/shared/errors'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { StepGraph, StepState } from '@yaac/shared/steps'

/**
 * Step rows (docs/workspace-steps.md): a workspace's steps, each running in
 * the tmux window named after it. A request (steps added, a step reset for
 * a rerun) writes through the functions on the barrel; what the step
 * reconcile observes arrives as a `step-changed` event, and a new life
 * replaces the start steps through `workspace-life-started`.
 */

export type StepRow = NullsToUndefined<typeof workspaceSteps.$inferSelect>

const UNSETTLED: StepState[] = ['pending', 'running', 'ready']

/** A workspace's steps of every life, in order. */
export async function listWorkspaceSteps(workspaceId: string): Promise<StepRow[]> {
  const db = await getDb()
  const rows = await db.select().from(workspaceSteps)
    .where(eq(workspaceSteps.workspaceId, workspaceId))
    .orderBy(asc(workspaceSteps.ordinal))
  return rows.map((r) => nullsToUndefined(r))
}

/** The steps of each of `workspaceIds`, in order. */
export async function listStepsFor(workspaceIds: string[]): Promise<Map<string, StepRow[]>> {
  const out = new Map<string, StepRow[]>()
  if (workspaceIds.length === 0) return out
  const db = await getDb()
  const rows = await db.select().from(workspaceSteps)
    .where(inArray(workspaceSteps.workspaceId, workspaceIds))
    .orderBy(asc(workspaceSteps.ordinal))
  for (const r of rows) out.set(r.workspaceId, [...(out.get(r.workspaceId) ?? []), nullsToUndefined(r)])
  return out
}

/**
 * Start a life's graph: the start steps of the last life are replaced by
 * `graph`'s, all pending, and an added step that had not settled is
 * `interrupted`, since an added step runs once. An added step of an earlier
 * life whose name `graph` takes is dropped.
 */
export async function startLifeSteps(projectId: string, workspaceId: string, life: Date, graph: StepGraph): Promise<void> {
  const db = await getDb()
  const names = Object.keys(graph)
  await db.transaction(async (tx) => {
    await tx.delete(workspaceSteps).where(and(eq(workspaceSteps.workspaceId, workspaceId),
      names.length > 0
        ? sql`(${workspaceSteps.origin} = 'start' OR ${inArray(workspaceSteps.name, names)})`
        : eq(workspaceSteps.origin, 'start')))
    await tx.update(workspaceSteps).set({ state: 'interrupted', finishedAt: new Date() })
      .where(and(eq(workspaceSteps.workspaceId, workspaceId), inArray(workspaceSteps.state, UNSETTLED)))
    if (names.length === 0) return
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(${max(workspaceSteps.ordinal)} + 1, 0)` })
      .from(workspaceSteps).where(eq(workspaceSteps.workspaceId, workspaceId))
    await tx.insert(workspaceSteps).values(names.map((name, i) => ({
      workspaceId, projectId, name, origin: 'start' as const, spec: graph[name], state: 'pending' as const,
      life, ordinal: Number(next) + i,
    })))
  })
}

/**
 * Add steps to a running workspace's life, after its others. A name a step
 * of this life holds is a `CONFLICT`; an earlier life's step of that name is
 * replaced.
 */
export async function insertAddedSteps(projectId: string, workspaceId: string, life: Date, graph: StepGraph): Promise<StepRow[]> {
  const names = Object.keys(graph)
  if (names.length === 0) return []
  const db = await getDb()
  return await db.transaction(async (tx) => {
    const taken = await tx.select({ name: workspaceSteps.name }).from(workspaceSteps)
      .where(and(eq(workspaceSteps.workspaceId, workspaceId), inArray(workspaceSteps.name, names),
        eq(workspaceSteps.life, life)))
    if (taken.length > 0) throw new ServerError('CONFLICT', `step "${taken[0].name}" already exists in this workspace`)
    await tx.delete(workspaceSteps).where(and(eq(workspaceSteps.workspaceId, workspaceId),
      inArray(workspaceSteps.name, names), lt(workspaceSteps.life, life)))
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(${max(workspaceSteps.ordinal)} + 1, 0)` })
      .from(workspaceSteps).where(eq(workspaceSteps.workspaceId, workspaceId))
    const rows = await tx.insert(workspaceSteps).values(names.map((name, i) => ({
      workspaceId, projectId, name, origin: 'added' as const, spec: graph[name], state: 'pending' as const,
      life, ordinal: Number(next) + i,
    }))).returning()
    return rows.map((r) => nullsToUndefined(r))
  })
}

/**
 * Put steps of `life` back to pending, for a rerun or a service's restart.
 * `startedAt` stays until the relaunch stamps it again, so the log of the
 * run before stays readable meanwhile (`yaac-mama logs`).
 */
export async function resetSteps(workspaceId: string, life: Date, names: string[]): Promise<void> {
  if (names.length === 0) return
  const db = await getDb()
  await db.update(workspaceSteps)
    .set({ state: 'pending', exitCode: null, readyAt: null, finishedAt: null })
    .where(and(eq(workspaceSteps.workspaceId, workspaceId), eq(workspaceSteps.life, life),
      inArray(workspaceSteps.name, names)))
}

/**
 * Record a step's new state, stamping when it started, became ready or
 * settled. Only the life the change was observed in is written, so a
 * report about a window of an earlier life changes nothing, and a settled
 * step stays settled until a rerun resets it.
 */
export async function recordStepChange(
  workspaceId: string,
  life: Date,
  name: string,
  change: { state: StepState; exitCode?: number },
): Promise<void> {
  const db = await getDb()
  const now = new Date()
  const { state } = change
  await db.update(workspaceSteps).set({
    state,
    ...(change.exitCode !== undefined ? { exitCode: change.exitCode } : {}),
    ...(state === 'running' ? { startedAt: now } : {}),
    ...(state === 'ready' ? { readyAt: now } : {}),
    ...(!UNSETTLED.includes(state) ? { finishedAt: now } : {}),
  }).where(and(eq(workspaceSteps.workspaceId, workspaceId), eq(workspaceSteps.life, life),
    eq(workspaceSteps.name, name), inArray(workspaceSteps.state, UNSETTLED), ne(workspaceSteps.state, state)))
}
