import { createHash } from 'node:crypto'
import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { getDb } from './client'
import { releaseOwnedGroups } from './group-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { launchApprovals, namedWorkflows, queuedWorkspaces, workflows, workspaceLifeWorkflows, workspaces } from './schema'
import { ServerError } from '@yaac/shared/errors'
import { isUuid } from '#lib/uuid'
import type { StepGraph } from '@yaac/shared/steps'

/**
 * Workflows (docs/workflows.md): a project's step graphs, each with the run
 * secrets it names and the repos its steps are written for, stored once per
 * content and never changed; the names a project points at them by, and
 * which of those are init workflows; and the commits and branches people
 * approved each privileged launch's spec to run on. Writes to the names
 * notify the snapshot hub, which carries every named workflow.
 */

export interface WorkflowRow {
  id: string
  projectId: string
  steps: StepGraph
  secrets: string[]
  /** Repo ids, sorted. */
  repos: string[]
  /** A person wrote or approved this content (docs/workflows.md
   *  "Approvals"). */
  personWritten: boolean
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
  personWritten: workflows.personWritten,
}

/** The workflow holding this content, stored if none does yet, marked as
 *  a person's when `byPerson`. */
export async function storeWorkflow(
  projectId: string,
  content: { steps: StepGraph; secrets: string[]; repos?: string[] },
  byPerson = false,
): Promise<WorkflowRow> {
  const db = await getDb()
  const repos = [...new Set(content.repos ?? [])].sort()
  const hash = workflowHash(content.steps, content.secrets, repos)
  await db.insert(workflows).values({ projectId, steps: content.steps, secrets: content.secrets, repos, hash, personWritten: byPerson })
    .onConflictDoNothing()
  const where = and(eq(workflows.projectId, projectId), eq(workflows.hash, hash))
  if (byPerson) await db.update(workflows).set({ personWritten: true }).where(where)
  const [row] = await db.select(workflowColumns).from(workflows).where(where)
  return row
}

/** Mark a workflow's content as approved by a person who was shown it. */
export async function markPersonWritten(id: string): Promise<void> {
  const db = await getDb()
  await db.update(workflows).set({ personWritten: true }).where(eq(workflows.id, id))
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

/** A project's named workflows, or every project's for the snapshot. */
export async function listNamedWorkflows(projectId?: string): Promise<NamedWorkflowRow[]> {
  return await named(projectId !== undefined ? eq(namedWorkflows.projectId, projectId) : undefined)
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
  notifyWorkspaceListChanged()
}

/** Point a named workflow at another workflow, and mark or unmark it as an
 *  init workflow. */
export async function updateNamedWorkflow(id: string, patch: { workflowId?: string; init?: boolean }): Promise<void> {
  const db = await getDb()
  await db.update(namedWorkflows).set(patch).where(eq(namedWorkflows.id, id))
  notifyWorkspaceListChanged()
}

/** Make exactly `ids` the project's init workflows. */
export async function setInitWorkflows(projectId: string, ids: string[]): Promise<void> {
  const db = await getDb()
  await db.update(namedWorkflows)
    .set({ init: ids.length > 0 ? inArray(namedWorkflows.id, ids) : sql`false` })
    .where(eq(namedWorkflows.projectId, projectId))
  notifyWorkspaceListChanged()
}

/** Delete a named workflow; the workflows, and their approvals, stay
 *  while anything names them. */
export async function deleteNamedWorkflow(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(namedWorkflows).where(eq(namedWorkflows.id, id))
  await releaseOwnedGroups({ kind: 'workflow', id })
  notifyWorkspaceListChanged()
}

/** Delete a project's named workflows and workflows, once nothing else of
 *  the project names them. */
export async function deleteProjectWorkflows(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(namedWorkflows).where(eq(namedWorkflows.projectId, projectId))
  await db.delete(workflows).where(eq(workflows.projectId, projectId))
  notifyWorkspaceListChanged()
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

/**
 * What a privileged launch runs apart from its commits (docs/workflows.md
 * "Approvals"): `spec` keys its approvals, and the approvals go away with
 * its workflow, and its site where it is a site's deploy.
 */
export interface LaunchSpec {
  spec: string
  workflowId: string
  siteId?: string
}

/** Approve `refs` (commits, or `<repo id>:refs/heads/<branch>`) for a
 *  spec. */
export async function addApprovals(spec: LaunchSpec, refs: string[]): Promise<void> {
  if (refs.length === 0) return
  const db = await getDb()
  await db.insert(launchApprovals)
    .values(refs.map((ref) => ({ spec: spec.spec, ref, workflowId: spec.workflowId, siteId: spec.siteId ?? null })))
    .onConflictDoNothing()
}

/** What a spec is approved to run on, in order. */
export async function listApprovals(spec: string): Promise<string[]> {
  const db = await getDb()
  return (await db.select({ ref: launchApprovals.ref }).from(launchApprovals)
    .where(eq(launchApprovals.spec, spec)).orderBy(launchApprovals.ref)).map((r) => r.ref)
}
