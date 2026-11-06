import { and, desc, eq, inArray, max } from 'drizzle-orm'
import { getDb } from './client'
import { workflowApprovals, workflowRevisions, workflowRuns, workflows } from './schema'
import { ServerError } from '@yaac/shared/errors'
import { isUuid } from '#lib/uuid'
import type { StepGraph } from '@yaac/shared/steps'

/**
 * Workflows (docs/workflows.md): a project's named step graphs, each held
 * as immutable revisions, with the commits and branches people approved it
 * to run on and the (revision, commit) pairs that ran with their secrets.
 */

export interface WorkflowRevisionRow {
  id: string
  workflowId: string
  number: number
  steps: StepGraph
  secrets: string[]
  createdAt: Date
}

/** A workflow with its current revision. */
export interface WorkflowRow {
  id: string
  projectId: string
  name: string
  createdAt: Date
  current: WorkflowRevisionRow
}

type Workflow = typeof workflows.$inferSelect

/** Each workflow joined to its highest-numbered revision. */
async function withCurrent(rows: Workflow[]): Promise<WorkflowRow[]> {
  if (rows.length === 0) return []
  const db = await getDb()
  const revisions = await db.select().from(workflowRevisions)
    .where(inArray(workflowRevisions.workflowId, rows.map((r) => r.id)))
    .orderBy(desc(workflowRevisions.number))
  return rows.map((w) => ({ ...w, current: revisions.find((r) => r.workflowId === w.id) as WorkflowRevisionRow }))
}

export async function listWorkflows(projectId: string): Promise<WorkflowRow[]> {
  const db = await getDb()
  return await withCurrent(await db.select().from(workflows)
    .where(eq(workflows.projectId, projectId)).orderBy(workflows.name))
}

export async function getWorkflow(id: string): Promise<WorkflowRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  return (await withCurrent(await db.select().from(workflows).where(eq(workflows.id, id))))[0]
}

export async function findWorkflowByName(projectId: string, name: string): Promise<WorkflowRow | undefined> {
  const db = await getDb()
  return (await withCurrent(await db.select().from(workflows)
    .where(and(eq(workflows.projectId, projectId), eq(workflows.name, name)))))[0]
}

/** Create a workflow with its first revision, refusing a name its project
 *  uses. */
export async function insertWorkflow(
  projectId: string,
  name: string,
  revision: { steps: StepGraph; secrets: string[] },
): Promise<WorkflowRow> {
  const db = await getDb()
  return await db.transaction(async (tx) => {
    const [row] = await tx.insert(workflows).values({ projectId, name }).onConflictDoNothing().returning()
    if (!row) throw new ServerError('CONFLICT', `this project already has a workflow named "${name}"`)
    const [current] = await tx.insert(workflowRevisions).values({ workflowId: row.id, number: 1, ...revision }).returning()
    return { ...row, current }
  })
}

/** Add a revision, which becomes current. */
export async function addWorkflowRevision(
  workflowId: string,
  revision: { steps: StepGraph; secrets: string[] },
): Promise<WorkflowRevisionRow> {
  const db = await getDb()
  return await db.transaction(async (tx) => {
    const [{ top }] = await tx.select({ top: max(workflowRevisions.number) }).from(workflowRevisions)
      .where(eq(workflowRevisions.workflowId, workflowId))
    const [row] = await tx.insert(workflowRevisions)
      .values({ workflowId, number: (top ?? 0) + 1, ...revision }).returning()
    return row
  })
}

export async function getWorkflowRevision(id: string): Promise<WorkflowRevisionRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const [row] = await db.select().from(workflowRevisions).where(eq(workflowRevisions.id, id))
  return row
}

/** A workflow's revisions, newest first. */
export async function listWorkflowRevisions(workflowId: string): Promise<WorkflowRevisionRow[]> {
  const db = await getDb()
  return await db.select().from(workflowRevisions)
    .where(eq(workflowRevisions.workflowId, workflowId)).orderBy(desc(workflowRevisions.number))
}

/** Delete a workflow with its revisions, approvals and recorded runs. */
export async function deleteWorkflow(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(workflows).where(eq(workflows.id, id))
}

export async function deleteProjectWorkflows(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workflows).where(eq(workflows.projectId, projectId))
}

/** Approve a commit or `refs/heads/<branch>` for a workflow. */
export async function addWorkflowApproval(workflowId: string, ref: string): Promise<void> {
  const db = await getDb()
  await db.insert(workflowApprovals).values({ workflowId, ref }).onConflictDoNothing()
}

/** What a workflow is approved to run on, in name order. */
export async function listWorkflowApprovals(workflowId: string): Promise<string[]> {
  const db = await getDb()
  return (await db.select({ ref: workflowApprovals.ref }).from(workflowApprovals)
    .where(eq(workflowApprovals.workflowId, workflowId)).orderBy(workflowApprovals.ref)).map((r) => r.ref)
}

export async function recordWorkflowRun(revisionId: string, commit: string): Promise<void> {
  const db = await getDb()
  await db.insert(workflowRuns).values({ revisionId, commit }).onConflictDoNothing()
}

export async function workflowRan(revisionId: string, commit: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.select({ commit: workflowRuns.commit }).from(workflowRuns)
    .where(and(eq(workflowRuns.revisionId, revisionId), eq(workflowRuns.commit, commit)))
  return rows.length > 0
}
