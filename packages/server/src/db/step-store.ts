import { and, asc, eq, getTableColumns, inArray, max, ne, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from './client'
import { workspaceLifeWorkflows, workspaceLives, workspaceSteps } from './schema'
import { isCurrentLife } from './current-life'
import { ServerError } from '@yaac/shared/errors'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { StepGraph, StepState } from '@yaac/shared/steps'

/**
 * Step rows (docs/workspace-steps.md): a workspace's steps, keyed by their
 * life, the name their workflow has in the workspace and their own, each
 * running in the tmux window named by the last two. A life's workflows are
 * rows of their own, which hold the stored workflow each came from. A
 * request (steps added, a step reset for a rerun) writes through the
 * functions on the barrel; what the step reconcile observes arrives as a
 * `step-changed` event, and a new life's start steps through the event that
 * starts it.
 */

/** A step with the stored workflow it came from. */
export type StepRow = NullsToUndefined<typeof workspaceSteps.$inferSelect> & { workflowId: string }

/** A step within its workspace: its workflow's name there, and its own. */
export interface StepKey {
  workflowName: string
  name: string
}

/** A workflow a life starts: the stored workflow, the name it has in the
 *  workspace, and its graph. `skip` names steps that start `skipped`
 *  (a cycle through several workflows). */
export interface LifeWorkflow {
  id: string
  name: string
  steps: StepGraph
  skip?: string[]
}

const keyed = (keys: StepKey[]): SQL | undefined =>
  or(...keys.map((k) => and(eq(workspaceSteps.workflowName, k.workflowName), eq(workspaceSteps.name, k.name))))

const stepColumns = { ...getTableColumns(workspaceSteps), workflowId: workspaceLifeWorkflows.workflowId }

/** Pairs a step with its workflow in its life. */
const ofStep = and(
  eq(workspaceLifeWorkflows.workspaceId, workspaceSteps.workspaceId),
  eq(workspaceLifeWorkflows.life, workspaceSteps.life),
  eq(workspaceLifeWorkflows.name, workspaceSteps.workflowName),
)

const UNSETTLED: StepState[] = ['pending', 'running', 'ready']

/** A workspace's steps of every life, in order. */
export async function listWorkspaceSteps(workspaceId: string): Promise<StepRow[]> {
  const db = await getDb()
  const rows = await db.select(stepColumns).from(workspaceSteps).innerJoin(workspaceLifeWorkflows, ofStep)
    .where(eq(workspaceSteps.workspaceId, workspaceId))
    .orderBy(asc(workspaceSteps.ordinal))
  return rows.map((r) => nullsToUndefined(r))
}

/** The current life's steps of each of `workspaceIds`, in order. */
export async function listStepsFor(workspaceIds: string[]): Promise<Map<string, StepRow[]>> {
  const out = new Map<string, StepRow[]>()
  if (workspaceIds.length === 0) return out
  const db = await getDb()
  const rows = await db.select(stepColumns).from(workspaceSteps).innerJoin(workspaceLifeWorkflows, ofStep)
    .innerJoin(workspaceLives, and(
      eq(workspaceLives.workspaceId, workspaceSteps.workspaceId), eq(workspaceLives.startedAt, workspaceSteps.life), isCurrentLife,
    ))
    .where(inArray(workspaceSteps.workspaceId, workspaceIds))
    .orderBy(asc(workspaceSteps.ordinal))
  for (const r of rows) out.set(r.workspaceId, [...(out.get(r.workspaceId) ?? []), nullsToUndefined(r)])
  return out
}

/**
 * Record what a life starts with: its workflows, their steps all pending,
 * and the init workflows it skipped. A step of an earlier life that had not
 * settled is `interrupted`.
 */
export async function startLifeSteps(
  projectId: string,
  workspaceId: string,
  life: Date,
  flows: LifeWorkflow[],
  skipped: Array<{ id: string; name: string }> = [],
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(workspaceSteps).set({ state: 'interrupted', finishedAt: new Date() })
      .where(and(eq(workspaceSteps.workspaceId, workspaceId), inArray(workspaceSteps.state, UNSETTLED)))
    if (flows.length + skipped.length === 0) return
    await tx.insert(workspaceLifeWorkflows).values([
      ...flows.map((f) => ({ workspaceId, life, name: f.name, workflowId: f.id })),
      ...skipped.map((f) => ({ workspaceId, life, name: f.name, workflowId: f.id, skipped: true })),
    ])
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(${max(workspaceSteps.ordinal)} + 1, 0)` })
      .from(workspaceSteps).where(eq(workspaceSteps.workspaceId, workspaceId))
    const now = new Date()
    const rows = flows.flatMap((f) => Object.entries(f.steps).map(([name, spec]) => {
      const skip = f.skip?.includes(name) === true
      return {
        workspaceId, projectId, workflowName: f.name, name, origin: 'start' as const, spec,
        state: skip ? 'skipped' as const : 'pending' as const, ...(skip ? { finishedAt: now } : {}), life,
      }
    })).map((row, i) => ({ ...row, ordinal: Number(next) + i }))
    if (rows.length > 0) await tx.insert(workspaceSteps).values(rows)
  })
}

/**
 * Add a workflow's steps to a running workspace's life, after its others.
 * A workflow of that name with steps in this life is a `CONFLICT`. One with
 * none (an init workflow the life skipped, or one that had no steps then)
 * has not run, so the added workflow takes its row.
 */
export async function insertAddedSteps(
  projectId: string,
  workspaceId: string,
  life: Date,
  workflow: { id: string; name: string },
  graph: StepGraph,
): Promise<StepRow[]> {
  const names = Object.keys(graph)
  if (names.length === 0) return []
  const db = await getDb()
  return await db.transaction(async (tx) => {
    const added = await tx.insert(workspaceLifeWorkflows)
      .values({ workspaceId, life, name: workflow.name, workflowId: workflow.id })
      .onConflictDoUpdate({
        target: [workspaceLifeWorkflows.workspaceId, workspaceLifeWorkflows.life, workspaceLifeWorkflows.name],
        set: { workflowId: workflow.id, skipped: false },
        setWhere: sql`not exists (select 1 from workspace_steps s where s.workspace_id = ${workspaceId}
          and s.life = ${life.toISOString()}::timestamptz and s.workflow_name = ${workflow.name})`,
      }).returning({ name: workspaceLifeWorkflows.name })
    if (added.length === 0) throw new ServerError('CONFLICT', `workflow "${workflow.name}" already runs in this workspace`)
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(${max(workspaceSteps.ordinal)} + 1, 0)` })
      .from(workspaceSteps).where(eq(workspaceSteps.workspaceId, workspaceId))
    const rows = await tx.insert(workspaceSteps).values(names.map((name, i) => ({
      workspaceId, projectId, workflowName: workflow.name, name, origin: 'added' as const,
      spec: graph[name], state: 'pending' as const, life, ordinal: Number(next) + i,
    }))).returning()
    return rows.map((r) => ({ ...nullsToUndefined(r), workflowId: workflow.id }))
  })
}

/**
 * Put steps of `life` back to pending, for a rerun or a service's restart.
 * `startedAt` stays until the relaunch stamps it again, so the log of the
 * run before stays readable meanwhile (`yaac-mama logs`).
 */
export async function resetSteps(workspaceId: string, life: Date, keys: StepKey[]): Promise<void> {
  if (keys.length === 0) return
  const db = await getDb()
  await db.update(workspaceSteps)
    .set({ state: 'pending', exitCode: null, readyAt: null, finishedAt: null })
    .where(and(eq(workspaceSteps.workspaceId, workspaceId), eq(workspaceSteps.life, life), keyed(keys)))
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
  key: StepKey,
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
    eq(workspaceSteps.workflowName, key.workflowName), eq(workspaceSteps.name, key.name),
    inArray(workspaceSteps.state, UNSETTLED), ne(workspaceSteps.state, state)))
}
