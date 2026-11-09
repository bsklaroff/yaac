import { createHash } from 'node:crypto'
import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { getDb } from './client'
import {
  namedWorkflows, projects, queuedWorkspaces, workflowApprovals, workflowRuns, workflows, workspaceSteps, workspaces,
} from './schema'
import { ServerError } from '@yaac/shared/errors'
import { isUuid } from '#lib/uuid'
import type { StepGraph } from '@yaac/shared/steps'

/**
 * Workflows (docs/workflows.md): a project's step graphs, each with the run
 * secrets it names, stored once per content and never changed; the names
 * a project points at them by; the commits and branches people approved a
 * named workflow's current workflow to run on; and the (workflow, commit)
 * pairs that ran with their secrets.
 */

export interface WorkflowRow {
  id: string
  projectId: string
  steps: StepGraph
  secrets: string[]
}

/** A named workflow, with the workflow it points at. */
export interface NamedWorkflowRow {
  id: string
  projectId: string
  name: string
  createdAt: Date
  workflow: WorkflowRow
}

/**
 * What keys a workflow's content: its graph as written, then its secrets.
 * The migration that moved inline graphs here computes the same in SQL, so
 * a graph stored before it is found again.
 */
function workflowHash(steps: StepGraph, secrets: string[]): string {
  return createHash('sha256').update(`${JSON.stringify(steps)}\n${secrets.join(',')}`).digest('hex')
}

const workflowColumns = {
  id: workflows.id,
  projectId: workflows.projectId,
  steps: workflows.steps,
  secrets: workflows.secrets,
}

/** The workflow holding this content, stored if none does yet. */
export async function storeWorkflow(projectId: string, content: { steps: StepGraph; secrets: string[] }): Promise<WorkflowRow> {
  const db = await getDb()
  const hash = workflowHash(content.steps, content.secrets)
  await db.insert(workflows).values({ projectId, ...content, hash }).onConflictDoNothing()
  const [row] = await db.select(workflowColumns).from(workflows)
    .where(and(eq(workflows.projectId, projectId), eq(workflows.hash, hash)))
  return row
}

export async function getWorkflow(id: string): Promise<WorkflowRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const [row] = await db.select(workflowColumns).from(workflows).where(eq(workflows.id, id))
  return row
}

async function named(where: ReturnType<typeof eq> | undefined): Promise<NamedWorkflowRow[]> {
  const db = await getDb()
  const rows = await db.select({
    id: namedWorkflows.id,
    projectId: namedWorkflows.projectId,
    name: namedWorkflows.name,
    createdAt: namedWorkflows.createdAt,
    workflow: workflowColumns,
  }).from(namedWorkflows).innerJoin(workflows, eq(workflows.id, namedWorkflows.workflowId))
    .where(where).orderBy(namedWorkflows.name)
  return rows
}

export async function listNamedWorkflows(projectId: string): Promise<NamedWorkflowRow[]> {
  return await named(eq(namedWorkflows.projectId, projectId))
}

export async function getNamedWorkflow(id: string): Promise<NamedWorkflowRow | undefined> {
  if (!isUuid(id)) return undefined
  return (await named(eq(namedWorkflows.id, id)))[0]
}

export async function findNamedWorkflow(projectId: string, name: string): Promise<NamedWorkflowRow | undefined> {
  return (await named(and(eq(namedWorkflows.projectId, projectId), eq(namedWorkflows.name, name))))[0]
}

/** Name a workflow, refusing a name its project uses. */
export async function insertNamedWorkflow(projectId: string, name: string, workflowId: string): Promise<void> {
  const db = await getDb()
  const rows = await db.insert(namedWorkflows).values({ projectId, name, workflowId }).onConflictDoNothing().returning()
  if (rows.length === 0) throw new ServerError('CONFLICT', `this project already has a workflow named "${name}"`)
}

/** Point a named workflow at another workflow. */
export async function pointNamedWorkflow(id: string, workflowId: string): Promise<void> {
  const db = await getDb()
  await db.update(namedWorkflows).set({ workflowId }).where(eq(namedWorkflows.id, id))
}

/** Delete a named workflow and its approvals; the workflows stay while
 *  anything names them. */
export async function deleteNamedWorkflow(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(namedWorkflows).where(eq(namedWorkflows.id, id))
}

/** Delete a project's named workflows and workflows, once nothing else of
 *  the project names them. */
export async function deleteProjectWorkflows(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(namedWorkflows).where(eq(namedWorkflows.projectId, projectId))
  await db.delete(workflows).where(eq(workflows.projectId, projectId))
}

/**
 * Delete every workflow nothing names: no named workflow, project, queued
 * entry, workspace or added step (routines and sites name named workflows). Its
 * recorded runs go with it, and with nothing to launch it they could not be
 * used.
 */
export async function deleteUnnamedWorkflows(): Promise<number> {
  const db = await getDb()
  const unused = (
    table: typeof namedWorkflows | typeof projects | typeof queuedWorkspaces | typeof workspaces | typeof workspaceSteps,
    column: AnyPgColumn) => notExists(db.select({ one: sql`1` }).from(table).where(eq(column, workflows.id)))
  const rows = await db.delete(workflows).where(and(
    // One stored a moment ago may not be named yet by what stored it.
    lt(workflows.createdAt, new Date(Date.now() - 60 * 60_000)),
    unused(namedWorkflows, namedWorkflows.workflowId),
    unused(projects, projects.initWorkflowId),
    unused(queuedWorkspaces, queuedWorkspaces.workflowId),
    unused(workspaces, workspaces.workflowId),
    unused(workspaceSteps, workspaceSteps.workflowId),
  )).returning({ id: workflows.id })
  return rows.length
}

/** Approve a commit or `refs/heads/<branch>` for a named workflow. */
export async function addWorkflowApproval(namedWorkflowId: string, ref: string): Promise<void> {
  const db = await getDb()
  await db.insert(workflowApprovals).values({ namedWorkflowId, ref }).onConflictDoNothing()
}

/** What a named workflow is approved to run on, in order. */
export async function listWorkflowApprovals(namedWorkflowId: string): Promise<string[]> {
  const db = await getDb()
  return (await db.select({ ref: workflowApprovals.ref }).from(workflowApprovals)
    .where(eq(workflowApprovals.namedWorkflowId, namedWorkflowId)).orderBy(workflowApprovals.ref)).map((r) => r.ref)
}

/** Whether a named workflow that points at `workflowId` now is approved to
 *  run on one of `refs`. */
export async function workflowApproved(workflowId: string, refs: string[]): Promise<boolean> {
  if (refs.length === 0) return false
  const db = await getDb()
  const rows = await db.select({ ref: workflowApprovals.ref }).from(workflowApprovals)
    .innerJoin(namedWorkflows, eq(namedWorkflows.id, workflowApprovals.namedWorkflowId))
    .where(and(eq(namedWorkflows.workflowId, workflowId), inArray(workflowApprovals.ref, refs)))
  return rows.length > 0
}

export async function recordWorkflowRun(workflowId: string, commit: string): Promise<void> {
  const db = await getDb()
  await db.insert(workflowRuns).values({ workflowId, commit }).onConflictDoNothing()
}

export async function workflowRan(workflowId: string, commit: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.select({ commit: workflowRuns.commit }).from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.commit, commit)))
  return rows.length > 0
}
