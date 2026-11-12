import { createHash } from 'node:crypto'
import { and, eq, exists, inArray, isNotNull, lt, notExists, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { getDb } from './client'
import {
  namedWorkflows, queuedWorkspaces, workflowApprovals, workflows, workspaceLifeWorkflows, workspaceRepos, workspaces,
} from './schema'
import { ServerError } from '@yaac/shared/errors'
import { isUuid } from '#lib/uuid'
import type { StepGraph } from '@yaac/shared/steps'

/**
 * Workflows (docs/workflows.md): a project's step graphs, each with the run
 * secrets it names and the repos its steps are written for, stored once per
 * content and never changed; the names a project points at them by, and
 * which of those are init workflows; and the commits and branches people
 * approved a named workflow's current workflow to run on.
 */

export interface WorkflowRow {
  id: string
  projectId: string
  steps: StepGraph
  secrets: string[]
  /** Repo ids, sorted. */
  repos: string[]
}

/** A named workflow, with the workflow it points at. */
export interface NamedWorkflowRow {
  id: string
  projectId: string
  name: string
  init: boolean
  createdAt: Date
  workflow: WorkflowRow
}

/**
 * What keys a workflow's content: its graph as written, its secrets, then
 * its repos when it names any, so a workflow stored before workflows had
 * repos keeps its hash. The migration that moved inline graphs here
 * computes the same in SQL, so a graph stored before it is found again.
 */
export function workflowHash(steps: StepGraph, secrets: string[], repos: string[]): string {
  const content = `${JSON.stringify(steps)}\n${secrets.join(',')}${repos.length > 0 ? `\n${repos.join(',')}` : ''}`
  return createHash('sha256').update(content).digest('hex')
}

const workflowColumns = {
  id: workflows.id,
  projectId: workflows.projectId,
  steps: workflows.steps,
  secrets: workflows.secrets,
  repos: workflows.repos,
}

/** The workflow holding this content, stored if none does yet. */
export async function storeWorkflow(
  projectId: string,
  content: { steps: StepGraph; secrets: string[]; repos?: string[] },
): Promise<WorkflowRow> {
  const db = await getDb()
  const repos = [...new Set(content.repos ?? [])].sort()
  const hash = workflowHash(content.steps, content.secrets, repos)
  await db.insert(workflows).values({ projectId, steps: content.steps, secrets: content.secrets, repos, hash }).onConflictDoNothing()
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
    init: namedWorkflows.init,
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
export async function insertNamedWorkflow(projectId: string, name: string, workflowId: string, init = false): Promise<void> {
  const db = await getDb()
  const rows = await db.insert(namedWorkflows).values({ projectId, name, workflowId, init }).onConflictDoNothing().returning()
  if (rows.length === 0) throw new ServerError('CONFLICT', `this project already has a workflow named "${name}"`)
}

/** Point a named workflow at another workflow, and mark or unmark it as an
 *  init workflow. */
export async function updateNamedWorkflow(id: string, patch: { workflowId?: string; init?: boolean }): Promise<void> {
  const db = await getDb()
  await db.update(namedWorkflows).set(patch).where(eq(namedWorkflows.id, id))
}

/** Make exactly `ids` the project's init workflows. */
export async function setInitWorkflows(projectId: string, ids: string[]): Promise<void> {
  const db = await getDb()
  await db.update(namedWorkflows)
    .set({ init: ids.length > 0 ? inArray(namedWorkflows.id, ids) : sql`false` })
    .where(eq(namedWorkflows.projectId, projectId))
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
 * Delete every workflow nothing names: no named workflow, queued entry,
 * workspace or life of one (routines and sites name named workflows).
 */
export async function deleteUnnamedWorkflows(): Promise<number> {
  const db = await getDb()
  const unused = (
    table: typeof namedWorkflows | typeof queuedWorkspaces | typeof workspaces | typeof workspaceLifeWorkflows,
    column: AnyPgColumn) => notExists(db.select({ one: sql`1` }).from(table).where(eq(column, workflows.id)))
  const rows = await db.delete(workflows).where(and(
    // One stored a moment ago may not be named yet by what stored it.
    lt(workflows.createdAt, new Date(Date.now() - 60 * 60_000)),
    unused(namedWorkflows, namedWorkflows.workflowId),
    unused(queuedWorkspaces, queuedWorkspaces.workflowId),
    unused(workspaces, workspaces.workflowId),
    unused(workspaceLifeWorkflows, workspaceLifeWorkflows.workflowId),
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

/**
 * Whether a workspace that ran `workflowId` with its secrets (a
 * non-interactive one, or a site's release) started a checkout of
 * `repoId` at `commit`. Such a workspace exists only because its launch
 * passed the launch check, so it is the record of the run.
 */
export async function workflowRanAt(workflowId: string, repoId: string, commit: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.select({ one: sql`1` }).from(workspaces)
    .where(and(
      eq(workspaces.workflowId, workflowId),
      or(eq(workspaces.nonInteractive, true), isNotNull(workspaces.siteId)),
      exists(db.select({ one: sql`1` }).from(workspaceRepos).where(and(
        eq(workspaceRepos.workspaceId, workspaces.workspaceId),
        eq(workspaceRepos.repoId, repoId),
        eq(workspaceRepos.startCommit, commit),
      ))),
    )).limit(1)
  return rows.length > 0
}
