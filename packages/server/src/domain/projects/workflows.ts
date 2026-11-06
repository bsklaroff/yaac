import {
  addWorkflowApproval,
  addWorkflowRevision,
  deleteWorkflow as deleteWorkflowRow,
  findWorkflowByName,
  getWorkflow,
  getWorkflowRevision,
  insertWorkflow,
  listProjectSites,
  listRoutineRows,
  listRunSecrets,
  listWorkflowApprovals,
  listWorkflowRevisions,
  listWorkflows,
  recordWorkflowRun,
  workflowRan,
  type WorkflowRevisionRow,
  type WorkflowRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { WorkflowDetail, WorkflowEntry, WorkflowRevision } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { testEnv } from '@yaac/shared/env'
import { repoDir } from '@yaac/shared/project-paths'
import { assertProjectExists } from './detail'
import { pushProjectSecrets } from './env'
import { fetchProjectOrigin } from './origin'

/**
 * Workflows (docs/workflows.md): a project's named step graphs, kept as
 * immutable revisions. A revision may name run secrets, which reach a
 * launch of it only on a commit a person approved:
 *
 * - Only a person names secrets, in an edit carrying the whole graph, so
 *   no one vouches for steps they did not see. A workspace's agent may not
 *   name any, nor edit a workflow whose current revision does.
 * - A person's action approves the commit or branch it names (a routine's
 *   setup, a site's deploy or follow, a launch by hand); an agent's never
 *   does, and none waits for one.
 * - A launch of the current revision gets its secrets on an approved
 *   commit or an approved branch's tip, and any revision on a commit it
 *   already ran on with them.
 */

/** A name a workflow is known by on the command line. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The prefix an approved branch is stored under, beside approved commits. */
const BRANCH_REF = 'refs/heads/'

/** A request's principal, as opposed to the server or a workspace's agent. */
const isPerson = (actor: Actor): boolean => actor.kind === 'local' || actor.kind === 'tailnet'

function revisionWire(r: WorkflowRevisionRow): WorkflowRevision {
  return { number: r.number, steps: r.steps, secrets: r.secrets, createdAt: formatUtcTimestamp(r.createdAt.getTime()) }
}

async function entry(w: WorkflowRow): Promise<WorkflowEntry> {
  const approvals = await listWorkflowApprovals(w.id)
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    current: revisionWire(w.current),
    approvedCommits: approvals.filter((a) => !a.startsWith(BRANCH_REF)),
    approvedBranches: approvals.filter((a) => a.startsWith(BRANCH_REF)).map((a) => a.slice(BRANCH_REF.length)),
    createdAt: formatUtcTimestamp(w.createdAt.getTime()),
  }
}

export async function listProjectWorkflows(projectId: string): Promise<WorkflowEntry[]> {
  await assertProjectExists(projectId)
  return await Promise.all((await listWorkflows(projectId)).map(entry))
}

/** A workflow by name, refused as NOT_FOUND when the project has none. */
export async function resolveWorkflow(projectId: string, name: string): Promise<WorkflowRow> {
  const row = await findWorkflowByName(projectId, name)
  if (!row) throw new ServerError('NOT_FOUND', `this project has no workflow named "${name}"`)
  return row
}

export async function showWorkflow(projectId: string, name: string): Promise<WorkflowDetail> {
  const row = await resolveWorkflow(projectId, name)
  return { ...await entry(row), revisions: (await listWorkflowRevisions(row.id)).map(revisionWire) }
}

/** A graph a workflow may hold. `volume` may be needed, for a site's
 *  release (docs/public-sites.md); a launch checks the graph again. */
function checkSteps(raw: unknown): StepGraph {
  try {
    return parseStepGraph(raw, new Set(['volume']))
  } catch (err) {
    throw new ServerError('VALIDATION', (err as Error).message)
  }
}

/** Secrets a revision may name: a person's, each a run secret of the
 *  project. */
async function checkSecrets(actor: Actor, projectId: string, secrets: string[]): Promise<string[]> {
  if (secrets.length === 0) return []
  if (!isPerson(actor)) {
    throw new ServerError('FORBIDDEN', 'only a person names a workflow\'s run secrets, in the webapp or with `yaac workflow`')
  }
  const known = new Set((await listRunSecrets(projectId)).map((r) => r.name))
  const missing = secrets.find((n) => !known.has(n))
  if (missing !== undefined) throw new ServerError('VALIDATION', `this project has no run secret named ${missing}`)
  return [...new Set(secrets)]
}

export async function createWorkflow(actor: Actor, projectId: string, input: {
  name: string
  steps: unknown
  secrets?: string[]
}): Promise<WorkflowEntry> {
  await assertProjectExists(projectId)
  await authorizeProject(actor, projectId)
  const name = input.name.trim()
  if (!NAME_PATTERN.test(name)) {
    throw new ServerError('VALIDATION', `"${name}" is not a workflow name (letters, digits, '.', '_' and '-')`)
  }
  return await entry(await insertWorkflow(projectId, name, {
    steps: checkSteps(input.steps),
    secrets: await checkSecrets(actor, projectId, input.secrets ?? []),
  }))
}

/**
 * Add a revision. One that names secrets carries its whole graph, so the
 * person naming them saw every step; without a graph only the secrets
 * change, and only to none. An agent's edit names none, and may not
 * replace a revision that does.
 */
export async function editWorkflow(actor: Actor, projectId: string, name: string, input: {
  steps?: unknown
  secrets?: string[]
}): Promise<WorkflowEntry> {
  await authorizeProject(actor, projectId)
  const row = await resolveWorkflow(projectId, name)
  if (input.steps === undefined && input.secrets === undefined) {
    throw new ServerError('VALIDATION', 'nothing to change: give steps or secrets')
  }
  if (!isPerson(actor) && row.current.secrets.length > 0) {
    throw new ServerError('FORBIDDEN', `workflow "${name}" is given run secrets, so only a person edits it`)
  }
  const secrets = await checkSecrets(actor, projectId, input.secrets ?? row.current.secrets)
  if (secrets.length > 0 && input.steps === undefined) {
    throw new ServerError('VALIDATION', 'an edit that gives a workflow run secrets carries its whole graph, '
      + 'so the steps they reach are the ones you saw')
  }
  await addWorkflowRevision(row.id, {
    steps: input.steps !== undefined ? checkSteps(input.steps) : row.current.steps,
    secrets,
  })
  return await entry(await getWorkflow(row.id) as WorkflowRow)
}

/** Delete a workflow, refused while a routine or site runs it. */
export async function deleteWorkflow(actor: Actor, projectId: string, name: string): Promise<void> {
  await authorizeProject(actor, projectId)
  const row = await resolveWorkflow(projectId, name)
  const routine = (await listRoutineRows(projectId)).find((r) => r.workflowId === row.id)
  const site = (await listProjectSites(projectId)).find((s) => s.workflowId === row.id)
  if (routine !== undefined || site !== undefined) {
    throw new ServerError('CONFLICT', `workflow "${name}" is run by ${routine !== undefined
      ? `routine "${routine.name}"` : `site "${site?.name ?? ''}"`}; point it elsewhere first`)
  }
  await deleteWorkflowRow(row.id)
}

/**
 * The commit or branch a routine or site will run a workflow on, as its
 * setup or a deploy names it. A person's action approves it; any other must
 * find it approved already when the workflow's current revision names
 * secrets, since nothing an agent does approves.
 */
export async function approveWorkflowRef(actor: Actor, workflowId: string, on: { commit: string } | { branch: string }): Promise<void> {
  const ref = 'commit' in on ? on.commit : `${BRANCH_REF}${on.branch}`
  if (isPerson(actor)) {
    await addWorkflowApproval(workflowId, ref)
    return
  }
  const row = await getWorkflow(workflowId)
  if (row !== undefined && row.current.secrets.length > 0 && !(await listWorkflowApprovals(workflowId)).includes(ref)) {
    throw new ServerError('FORBIDDEN', `workflow "${row.name}" is given run secrets, and no person has run it on `
      + `${'commit' in on ? on.commit.slice(0, 12) : `branch ${on.branch}`}`)
  }
}

/**
 * What a launch of a revision runs: its graph, and, when `secrets` (a
 * non-interactive launch or a site's release), the values of the run
 * secrets it names. Those reach it only at a commit, so a launch with
 * `commit` unset runs at the tip of `branch` (else the default), resolved
 * here; with `commit` set, `branch` says it is that branch's tip. A
 * person's launch approves its commit first. A launch the secrets may not
 * reach is refused rather than run without them; one that gets them is
 * recorded, so its pair may run again.
 */
export async function workflowLaunch(actor: Actor, projectId: string, opts: {
  revisionId: string
  commit?: string
  branch?: string
  secrets: boolean
}): Promise<{ revision: WorkflowRevisionRow; runSecrets: Record<string, string>; commit?: string }> {
  const revision = await getWorkflowRevision(opts.revisionId)
  const workflow = revision && await getWorkflow(revision.workflowId)
  if (!revision || workflow?.projectId !== projectId) {
    throw new ServerError('NOT_FOUND', 'that workflow revision is gone, its workflow deleted')
  }
  if (!opts.secrets || revision.secrets.length === 0) return { revision, runSecrets: {} }
  const branch = opts.commit === undefined ? opts.branch ?? await getDefaultBranch(repoDir(projectId)) : opts.branch
  let commit = opts.commit
  if (commit === undefined) {
    if (!testEnv.e2eSkipFetch) await fetchProjectOrigin(projectId)
    commit = await resolveRemoteRef(repoDir(projectId), branch as string).catch(() => {
      throw new ServerError('VALIDATION', `branch "${branch ?? ''}" not found on origin.`)
    })
  }
  if (isPerson(actor)) await addWorkflowApproval(workflow.id, commit)
  const approvals = await listWorkflowApprovals(workflow.id)
  const allowed = (workflow.current.id === revision.id
    && (approvals.includes(commit) || (branch !== undefined && approvals.includes(`${BRANCH_REF}${branch}`))))
    || await workflowRan(revision.id, commit)
  if (!allowed) {
    throw new ServerError('FORBIDDEN', `workflow "${workflow.name}" revision ${String(revision.number)} is given run `
      + `secrets, and no person has run it on ${commit.slice(0, 12)}; launch it yourself, or from a routine or `
      + 'site you set up')
  }
  const stored = new Map((await listRunSecrets(projectId)).map((r) => [r.name, r.value]))
  const runSecrets: Record<string, string> = {}
  for (const name of revision.secrets) {
    const value = stored.get(name)
    if (value === undefined) {
      throw new ServerError('VALIDATION', `run secret ${name} is ${stored.has(name) ? 'unreadable; re-enter it' : 'gone'}, `
        + `and workflow "${workflow.name}" needs it`)
    }
    runSecrets[name] = value
  }
  // The runtime gets the values before the launch names them.
  await pushProjectSecrets(projectId)
  await recordWorkflowRun(revision.id, commit)
  return { revision, runSecrets, ...(opts.commit === undefined ? { commit } : {}) }
}
