import {
  addWorkflowApproval,
  deleteNamedWorkflow,
  findNamedWorkflow,
  getNamedWorkflow,
  getProjectRow,
  getWorkflow,
  insertNamedWorkflow,
  listNamedWorkflows,
  listProjectSites,
  listQueuedWorkspaceRows,
  listRepoShares,
  listRoutineRows,
  listRunSecrets,
  listWorkflowApprovals,
  pointNamedWorkflow,
  recordWorkflowRun,
  storeWorkflow,
  workflowApproved,
  workflowRan,
  type NamedWorkflowRow,
  type WorkflowRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { WorkflowEntry } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { fetchRepoOrigin } from '#domain/repos'
import { testEnv } from '@yaac/shared/env'
import { repoDir } from '@yaac/shared/project-paths'
import { assertProjectExists } from './detail'
import { pushProjectSecrets } from './env'

/**
 * Workflows (docs/workflows.md): a project's step graphs, each with the run
 * secrets it names, stored once per content and never changed, and the
 * names a project points at them by. Every graph a workspace starts is a
 * workflow: one given by name, or one its `steps` made, which names no
 * secrets. A named workflow's secrets reach a launch only on a commit a
 * person approved:
 *
 * - Only a person names secrets, in an edit carrying the whole graph, so no
 *   one vouches for steps they did not see. A workspace's agent may not name
 *   any, nor edit a named workflow whose workflow does.
 * - A person's action approves the commit or branch it names (a routine's
 *   setup, a site's deploy or follow, a launch by hand); an agent's never
 *   does, and none waits for one.
 * - A launch gets the secrets on a commit approved for a named workflow that
 *   points at its workflow now, or on one that workflow already ran on with
 *   them.
 * - "The commit" is one repo's, so the secrets reach only a workspace that
 *   starts with exactly one repo, and a branch is approved for that repo.
 */

/** A name a workflow is known by on the command line. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Why a launch that gets run secrets, or a routine of such launches, is
 *  refused when it starts with no repo or several. */
export const RUN_SECRETS_NEED_ONE_REPO = 'this workflow is given run secrets, which reach only a workspace that '
  + 'starts with exactly one repo'

/** What an approved branch of a repo is stored as, beside approved commits. */
function branchRef(repoId: string, branch: string): string {
  return `${repoId}:refs/heads/${branch}`
}

/** A commit, or a branch of one of the project's repos, that a workflow is
 *  approved on. */
export type WorkflowRef = { commit: string } | { branch: string; repoId: string }

/** A request's principal, as opposed to the server or a workspace's agent. */
const isPerson = (actor: Actor): boolean => actor.kind === 'local' || actor.kind === 'tailnet'

/** A workflow as listed. An approved branch of a repo that is not the
 *  project's only one reads `<repo's folder>:<branch>`. */
async function entry(w: NamedWorkflowRow): Promise<WorkflowEntry> {
  const approvals = await listWorkflowApprovals(w.id)
  const repos = (await getProjectRow(w.projectId))?.repos ?? []
  const branches = approvals.flatMap((a) => {
    const m = /^([^:]+):refs\/heads\/(.+)$/.exec(a)
    if (!m) return []
    const dir = repos.find((l) => l.repo.id === m[1])?.dir
    return [repos.length === 1 || dir === undefined ? m[2] : `${dir}:${m[2]}`]
  })
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    steps: w.workflow.steps,
    secrets: w.workflow.secrets,
    approvedCommits: approvals.filter((a) => !a.includes('refs/heads/')),
    approvedBranches: branches,
    createdAt: formatUtcTimestamp(w.createdAt.getTime()),
  }
}

export async function listProjectWorkflows(projectId: string): Promise<WorkflowEntry[]> {
  await assertProjectExists(projectId)
  return await Promise.all((await listNamedWorkflows(projectId)).map(entry))
}

/** A named workflow, refused as NOT_FOUND when the project has none. */
export async function resolveWorkflow(projectId: string, name: string): Promise<NamedWorkflowRow> {
  const row = await findNamedWorkflow(projectId, name)
  if (!row) throw new ServerError('NOT_FOUND', `this project has no workflow named "${name}"`)
  return row
}

export async function showWorkflow(projectId: string, name: string): Promise<WorkflowEntry> {
  return await entry(await resolveWorkflow(projectId, name))
}

/** A graph as given, checked. `volume` may be needed, for a site's release
 *  (docs/public-sites.md); a launch checks the graph again. */
function checkSteps(raw: unknown): StepGraph {
  try {
    return parseStepGraph(raw, new Set(['volume']))
  } catch (err) {
    throw new ServerError('VALIDATION', (err as Error).message)
  }
}

/** The workflow a graph given by itself (`steps`) makes: it names no
 *  secrets, and one with the same graph is the same workflow. */
export async function storeSteps(projectId: string, raw: unknown): Promise<WorkflowRow> {
  return await storeWorkflow(projectId, { steps: checkSteps(raw), secrets: [] })
}

/** Secrets a workflow may name: a person's, each a run secret of the
 *  project, in order. */
async function checkSecrets(actor: Actor, projectId: string, secrets: string[]): Promise<string[]> {
  if (secrets.length === 0) return []
  if (!isPerson(actor)) {
    throw new ServerError('FORBIDDEN', 'only a person names a workflow\'s run secrets, in the webapp or with `yaac workflow`')
  }
  const known = new Set((await listRunSecrets(projectId)).map((r) => r.name))
  const missing = secrets.find((n) => !known.has(n))
  if (missing !== undefined) throw new ServerError('VALIDATION', `this project has no run secret named ${missing}`)
  return [...new Set(secrets)].sort()
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
  const workflow = await storeWorkflow(projectId, {
    steps: checkSteps(input.steps),
    secrets: await checkSecrets(actor, projectId, input.secrets ?? []),
  })
  await insertNamedWorkflow(projectId, name, workflow.id)
  return await showWorkflow(projectId, name)
}

/**
 * Point a named workflow at new content. An edit that names secrets
 * carries its whole graph, so the person naming them saw every step;
 * without a graph only the secrets change, and only to none. An agent's
 * edit names none, and may not replace a workflow that does.
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
  if (!isPerson(actor) && row.workflow.secrets.length > 0) {
    throw new ServerError('FORBIDDEN', `workflow "${name}" is given run secrets, so only a person edits it`)
  }
  const secrets = await checkSecrets(actor, projectId, input.secrets ?? row.workflow.secrets)
  if (secrets.length > 0 && input.steps === undefined) {
    throw new ServerError('VALIDATION', 'an edit that gives a workflow run secrets carries its whole graph, '
      + 'so the steps they reach are the ones you saw')
  }
  const workflow = await storeWorkflow(projectId, {
    steps: input.steps !== undefined ? checkSteps(input.steps) : row.workflow.steps,
    secrets,
  })
  await pointNamedWorkflow(row.id, workflow.id)
  return await showWorkflow(projectId, name)
}

/** Delete a named workflow, refused while anything follows it. */
export async function deleteWorkflow(actor: Actor, projectId: string, name: string): Promise<void> {
  await authorizeProject(actor, projectId)
  const row = await resolveWorkflow(projectId, name)
  const users = [
    ...(await listRoutineRows(projectId)).filter((r) => r.namedWorkflowId === row.id).map((r) => `routine "${r.name}"`),
    ...(await listProjectSites(projectId)).filter((s) => s.namedWorkflowId === row.id).map((s) => `site "${s.name}"`),
    ...(await getProjectRow(projectId))?.initNamedWorkflowId === row.id ? ['the project\'s init steps'] : [],
    ...(await listQueuedWorkspaceRows(projectId)).some((q) => q.namedWorkflowId === row.id) ? ['a queued workspace'] : [],
  ]
  if (users.length > 0) {
    throw new ServerError('CONFLICT', `workflow "${name}" is run by ${users[0]}; point it elsewhere first`)
  }
  await deleteNamedWorkflow(row.id)
}

/** The workflow a project's init steps are now, with the name it follows
 *  if any; undefined for none. */
export async function initWorkflowOf(projectId: string): Promise<{ workflow: WorkflowRow; name?: string } | undefined> {
  const project = await getProjectRow(projectId)
  if (project?.initNamedWorkflowId !== undefined) {
    const named = await getNamedWorkflow(project.initNamedWorkflowId)
    if (named) return { workflow: named.workflow, name: named.name }
  }
  const workflow = project?.initWorkflowId !== undefined ? await getWorkflow(project.initWorkflowId) : undefined
  return workflow && { workflow }
}

/**
 * Whether a routine or site may run a named workflow on the commit or
 * branch its setup or a deploy names, refusing before anything is written.
 * A branch is refused for a workflow that names secrets when another user
 * can push the repo's remote; and since nothing an agent does approves, an
 * agent's must be approved already when the workflow names secrets.
 */
export async function checkWorkflowRef(actor: Actor, namedWorkflowId: string, on: WorkflowRef): Promise<void> {
  await approvalRef(actor, namedWorkflowId, on)
}

/** `checkWorkflowRef`, answering what the ref is stored as; undefined for a
 *  workflow that names no secrets, which needs no approval. */
async function approvalRef(actor: Actor, namedWorkflowId: string, on: WorkflowRef): Promise<string | undefined> {
  const named = await getNamedWorkflow(namedWorkflowId)
  if (named === undefined || named.workflow.secrets.length === 0) return undefined
  let ref: string
  if ('commit' in on) ref = on.commit
  else {
    if (await remoteShared(on.repoId)) throw sharedBranchRefusal(named.name)
    ref = branchRef(on.repoId, on.branch)
  }
  if (!isPerson(actor) && !(await listWorkflowApprovals(namedWorkflowId)).includes(ref)) {
    throw new ServerError('FORBIDDEN', `workflow "${named.name}" is given run secrets, and no person has run it on `
      + `${'commit' in on ? on.commit.slice(0, 12) : `branch ${on.branch}`}`)
  }
  return ref
}

/** `checkWorkflowRef`, then a person's action approves the commit or
 *  branch: once what names it is written, for a caller that checked first. */
export async function approveWorkflowRef(actor: Actor, namedWorkflowId: string, on: WorkflowRef): Promise<void> {
  const ref = await approvalRef(actor, namedWorkflowId, on)
  if (ref !== undefined && isPerson(actor)) await addWorkflowApproval(namedWorkflowId, ref)
}

/**
 * Whether another user can push to a repo's remote: a hosted repo its owner
 * shared with anyone (docs/hosted-projects.md "Sharing"). A branch approval
 * gives its run secrets to whoever can push the branch, so none applies
 * there.
 */
async function remoteShared(repoId: string): Promise<boolean> {
  return (await listRepoShares()).some((s) => s.repoId === repoId)
}

function sharedBranchRefusal(what: string): ServerError {
  return new ServerError('FORBIDDEN', `${what === 'this workflow' ? what : `workflow "${what}"`} is given run secrets, `
    + 'and another user can push to this repo through a share, so a branch cannot be approved for it; '
    + 'run it at a commit instead')
}

/**
 * The values of the run secrets a launch of `workflowId` gets, when
 * `secrets` (a non-interactive launch or a site's release). They reach it
 * only at a commit of the one repo it starts with (`repoId`; a launch with
 * none or several is refused), so a launch with `commit` unset runs at the
 * tip of `branch` (else the default), resolved here; with `commit` set,
 * `branch` says it is that branch's tip. A person's launch through a named workflow
 * approves its commit for it first. A launch the secrets may not reach is
 * refused rather than run without them; one that gets them is recorded, so
 * that workflow may run on that commit again.
 */
export async function workflowLaunch(actor: Actor, projectId: string, opts: {
  workflowId: string
  namedWorkflowId?: string
  repoId?: string
  commit?: string
  branch?: string
  secrets: boolean
}): Promise<{ runSecrets: Record<string, string>; commit?: string }> {
  const workflow = await getWorkflow(opts.workflowId)
  if (workflow?.projectId !== projectId) throw new ServerError('NOT_FOUND', 'that workflow is gone')
  if (!opts.secrets || workflow.secrets.length === 0) return { runSecrets: {} }
  const { repoId } = opts
  if (repoId === undefined) throw new ServerError('VALIDATION', RUN_SECRETS_NEED_ONE_REPO)
  const main = repoDir(repoId)
  const branch = opts.commit === undefined ? opts.branch ?? await getDefaultBranch(main) : opts.branch
  let commit = opts.commit
  if (commit === undefined) {
    if (!testEnv.e2eSkipFetch) await fetchRepoOrigin(repoId)
    commit = await resolveRemoteRef(main, branch as string).catch(() => {
      throw new ServerError('VALIDATION', `branch "${branch ?? ''}" not found on origin.`)
    })
  }
  if (isPerson(actor) && opts.namedWorkflowId !== undefined) await addWorkflowApproval(opts.namedWorkflowId, commit)
  const byCommit = await workflowApproved(workflow.id, [commit]) || await workflowRan(workflow.id, commit)
  const byBranch = !byCommit && branch !== undefined
    && await workflowApproved(workflow.id, [branchRef(repoId, branch)])
  if (byBranch && await remoteShared(repoId)) throw sharedBranchRefusal('this workflow')
  if (!byCommit && !byBranch) {
    throw new ServerError('FORBIDDEN', 'this workflow is given run secrets, and no person has run it on '
      + `${commit.slice(0, 12)}; launch it yourself, or from a routine or site you set up`)
  }
  const stored = new Map((await listRunSecrets(projectId)).map((r) => [r.name, r.value]))
  const runSecrets: Record<string, string> = {}
  for (const name of workflow.secrets) {
    const value = stored.get(name)
    if (value === undefined) {
      throw new ServerError('VALIDATION', `run secret ${name} is ${stored.has(name) ? 'unreadable; re-enter it' : 'gone'}, `
        + 'and this workflow needs it')
    }
    runSecrets[name] = value
  }
  // The runtime gets the values before the launch names them.
  await pushProjectSecrets(projectId)
  await recordWorkflowRun(workflow.id, commit)
  return { runSecrets, ...(opts.commit === undefined ? { commit } : {}) }
}
