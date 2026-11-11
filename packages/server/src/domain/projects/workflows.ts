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
  listRoutineRows,
  listRunSecrets,
  listWorkflowApprovals,
  setInitWorkflows as storeInitWorkflows,
  storeWorkflow,
  updateNamedWorkflow,
  workflowApproved,
  workflowRanAt,
  type NamedWorkflowRow,
  type ProjectRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { isStepName, NAME_RULE, parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { RepoStart, WorkflowEntry } from '@yaac/shared/types'
import { authorizeProject, type Actor } from '#domain/access'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { fetchRepoOrigin } from '#domain/repos'
import { testEnv } from '@yaac/shared/env'
import { repoDir } from '@yaac/shared/project-paths'
import { assertProjectExists } from './detail'
import { pushProjectSecrets } from './env'
import { projectRepo } from './repos'

/**
 * Workflows (docs/workflows.md): a project's step graphs, each with the run
 * secrets it names and the repos its steps are written for, stored once per
 * content and never changed, and the names a project points at them by,
 * any number of which are init workflows. A named workflow's secrets reach
 * a launch only when every repo it starts with is at a commit a person
 * approved:
 *
 * - Only a person names secrets, in an edit carrying the whole graph, so no
 *   one vouches for steps they did not see. A workspace's agent may not name
 *   any, nor edit a named workflow whose workflow does.
 * - A person's action approves the commits or branches it names (a
 *   routine's setup, a site's deploy or follow, a launch by hand); an
 *   agent's never does, and none waits for one.
 * - A repo's commit passes when it is approved for a named workflow that
 *   points at the workflow now, when a workspace that ran the workflow with
 *   them started that repo there, or when it is the tip of a branch of that
 *   repo approved for such a named workflow.
 */

/** What an approved branch of a repo is stored as, beside approved commits. */
function branchRef(repoId: string, branch: string): string {
  return `${repoId}:refs/heads/${branch}`
}

/** A request's principal, as opposed to the server or a workspace's agent. */
const isPerson = (actor: Actor): boolean => actor.kind === 'local' || actor.kind === 'tailnet'

/** A repo of the project by its folder, or its id where it is linked no
 *  more. */
const dirOf = (project: ProjectRow | undefined, repoId: string): string =>
  project?.repos.find((l) => l.repo.id === repoId)?.dir ?? repoId

/** A workflow as listed. An approved branch of a repo that is not the
 *  project's only one reads `<repo's folder>@<branch>`. */
async function entry(w: NamedWorkflowRow): Promise<WorkflowEntry> {
  const approvals = await listWorkflowApprovals(w.id)
  const project = await getProjectRow(w.projectId)
  const links = project?.repos ?? []
  const branches = approvals.flatMap((a) => {
    const m = /^([^:]+):refs\/heads\/(.+)$/.exec(a)
    if (!m) return []
    return [links.length === 1 && links[0].repo.id === m[1] ? m[2] : `${dirOf(project, m[1])}@${m[2]}`]
  })
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    steps: w.workflow.steps,
    secrets: w.workflow.secrets,
    repos: w.workflow.repos.map((r) => dirOf(project, r)),
    init: w.init,
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

/** Repos of the project by folder or id, as their ids. */
export async function projectRepoIds(projectId: string, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return []
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  return [...new Set(refs.map((r) => projectRepo(project, r).repo.id))]
}

/**
 * The folders of the repos a workflow names that `have` (repo ids) lacks:
 * a workflow runs only in a workspace with a checkout of each
 * (docs/workflows.md "Repos").
 */
export async function missingRepos(projectId: string, workflowRepos: string[], have: string[]): Promise<string[]> {
  const missing = workflowRepos.filter((r) => !have.includes(r))
  if (missing.length === 0) return []
  const project = await getProjectRow(projectId)
  return missing.map((r) => dirOf(project, r))
}

/** Refuse a launch of a workflow whose repos `have` (repo ids) lacks. */
export async function assertWorkflowRepos(projectId: string, what: string, workflowRepos: string[], have: string[]): Promise<void> {
  const missing = await missingRepos(projectId, workflowRepos, have)
  if (missing.length > 0) {
    throw new ServerError('VALIDATION', `${what} runs in ${missing.join(', ')}, which this start does not include`)
  }
}

export async function createWorkflow(actor: Actor, projectId: string, input: {
  name: string
  steps: unknown
  secrets?: string[]
  repos?: string[]
  init?: boolean
}): Promise<WorkflowEntry> {
  await assertProjectExists(projectId)
  await authorizeProject(actor, projectId)
  const name = input.name.trim()
  if (!isStepName(name)) throw new ServerError('VALIDATION', `"${name}" is not a workflow name (${NAME_RULE})`)
  const workflow = await storeWorkflow(projectId, {
    steps: checkSteps(input.steps),
    secrets: await checkSecrets(actor, projectId, input.secrets ?? []),
    repos: await projectRepoIds(projectId, input.repos ?? []),
  })
  await insertNamedWorkflow(projectId, name, workflow.id, input.init === true)
  return await showWorkflow(projectId, name)
}

/**
 * Point a named workflow at new content, or mark or unmark it as an init
 * workflow. An edit that names secrets carries its whole graph, so the
 * person naming them saw every step; without a graph secrets change only
 * to none. A person may change the repos of a workflow that has secrets
 * without its graph, since its steps stay the ones they saw. An agent's
 * edit names none, and may not replace a workflow that does.
 */
export async function editWorkflow(actor: Actor, projectId: string, name: string, input: {
  steps?: unknown
  secrets?: string[]
  repos?: string[]
  init?: boolean
}): Promise<WorkflowEntry> {
  await authorizeProject(actor, projectId)
  const row = await resolveWorkflow(projectId, name)
  const content = input.steps !== undefined || input.secrets !== undefined || input.repos !== undefined
  if (!content && input.init === undefined) {
    throw new ServerError('VALIDATION', 'nothing to change: give steps, secrets, repos or init')
  }
  if (!content) {
    await updateNamedWorkflow(row.id, { init: input.init })
    return await showWorkflow(projectId, name)
  }
  if (!isPerson(actor) && row.workflow.secrets.length > 0) {
    throw new ServerError('FORBIDDEN', `workflow "${name}" is given run secrets, so only a person edits it`)
  }
  const secrets = await checkSecrets(actor, projectId, input.secrets ?? row.workflow.secrets)
  if (input.secrets !== undefined && secrets.length > 0 && input.steps === undefined) {
    throw new ServerError('VALIDATION', 'an edit that gives a workflow run secrets carries its whole graph, '
      + 'so the steps they reach are the ones you saw')
  }
  const workflow = await storeWorkflow(projectId, {
    steps: input.steps !== undefined ? checkSteps(input.steps) : row.workflow.steps,
    secrets,
    repos: input.repos !== undefined ? await projectRepoIds(projectId, input.repos) : row.workflow.repos,
  })
  await updateNamedWorkflow(row.id, { workflowId: workflow.id, ...(input.init !== undefined ? { init: input.init } : {}) })
  return await showWorkflow(projectId, name)
}

/** Make exactly the named workflows the project's init workflows. */
export async function setInitWorkflows(actor: Actor, projectId: string, names: string[]): Promise<WorkflowEntry[]> {
  await assertProjectExists(projectId)
  await authorizeProject(actor, projectId)
  const rows = await Promise.all([...new Set(names)].map((n) => resolveWorkflow(projectId, n)))
  await storeInitWorkflows(projectId, rows.map((r) => r.id))
  return (await listProjectWorkflows(projectId)).filter((w) => w.init)
}

/** Delete a named workflow, refused while a routine, site or queued entry
 *  follows it. Deleting an init workflow is how its steps stop running. */
export async function deleteWorkflow(actor: Actor, projectId: string, name: string): Promise<void> {
  await authorizeProject(actor, projectId)
  const row = await resolveWorkflow(projectId, name)
  const users = [
    ...(await listRoutineRows(projectId)).filter((r) => r.namedWorkflowId === row.id).map((r) => `routine "${r.name}"`),
    ...(await listProjectSites(projectId)).filter((s) => s.namedWorkflowId === row.id).map((s) => `site "${s.name}"`),
    ...(await listQueuedWorkspaceRows(projectId)).some((q) => q.namedWorkflowId === row.id) ? ['a queued workspace'] : [],
  ]
  if (users.length > 0) {
    throw new ServerError('CONFLICT', `workflow "${name}" is run by ${users[0]}; point it elsewhere first`)
  }
  await deleteNamedWorkflow(row.id)
}

/** A project's init workflows: started by every workspace that brings no
 *  graph of its own and has their repos. */
export async function listInitWorkflows(projectId: string): Promise<NamedWorkflowRow[]> {
  return (await listNamedWorkflows(projectId)).filter((w) => w.init)
}

/**
 * A short random name for a workflow that has none of its own in a
 * workspace (a create's `steps`, a step added with `run`), unique among
 * `taken` (the workspace's workflows) and the project's workflow names.
 */
export async function mintWorkflowName(projectId: string, taken: Iterable<string> = []): Promise<string> {
  const used = new Set([...taken, ...(await listNamedWorkflows(projectId)).map((w) => w.name)])
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const chars = `${letters}0123456789`
  for (;;) {
    const name = letters[Math.floor(Math.random() * letters.length)]
      + Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    if (!used.has(name)) return name
  }
}

/** What each repo of a start is approved as: its commit, or its branch of
 *  that repo. Stored selections name repos by id. */
function startRefs(repos: RepoStart[]): Array<{ repoId: string; ref: string; label: string }> {
  return repos.map((r) => {
    if (r.commit !== undefined) return { repoId: r.repo, ref: r.commit, label: r.commit.slice(0, 12) }
    if (r.branch === undefined) throw new ServerError('VALIDATION', 'a start approved for a workflow names a branch or commit per repo')
    return { repoId: r.repo, ref: branchRef(r.repo, r.branch), label: `branch ${r.branch}` }
  })
}

/**
 * Whether a routine or site may run a named workflow on the start it is
 * about to store (each repo at a commit or a branch), refusing before
 * anything is written. Nothing an agent does approves, so an agent's start
 * must be approved already when the workflow names secrets.
 */
export async function checkWorkflowStart(actor: Actor, namedWorkflowId: string, repos: RepoStart[]): Promise<void> {
  await startApprovals(actor, namedWorkflowId, repos)
}

/** `checkWorkflowStart`, answering the refs to approve; none for a
 *  workflow that names no secrets, which needs no approval. */
async function startApprovals(actor: Actor, namedWorkflowId: string, repos: RepoStart[]): Promise<string[]> {
  const named = await getNamedWorkflow(namedWorkflowId)
  if (named === undefined || named.workflow.secrets.length === 0) return []
  const refs = startRefs(repos)
  if (!isPerson(actor)) {
    const approved = new Set(await listWorkflowApprovals(namedWorkflowId))
    const missing = refs.find((r) => !approved.has(r.ref))
    if (missing !== undefined) {
      const project = await getProjectRow(named.projectId)
      throw new ServerError('FORBIDDEN', `workflow "${named.name}" is given run secrets, and no person has run it on `
        + `${dirOf(project, missing.repoId)}@${missing.label.replace(/^branch /, '')}`)
    }
  }
  return refs.map((r) => r.ref)
}

/** `checkWorkflowStart`, then a person's action approves each repo's
 *  commit or branch: once what names them is written, for a caller that
 *  checked first. */
export async function approveWorkflowStart(actor: Actor, namedWorkflowId: string, repos: RepoStart[]): Promise<void> {
  const refs = await startApprovals(actor, namedWorkflowId, repos)
  if (!isPerson(actor)) return
  for (const ref of refs) await addWorkflowApproval(namedWorkflowId, ref)
}

/** Whether `commit` is now the tip of a branch of `repoId` approved for a
 *  named workflow that points at `workflowId`. */
async function approvedTip(workflowId: string, projectId: string, repoId: string, commit: string): Promise<boolean> {
  const prefix = `${repoId}:refs/heads/`
  const branches = (await Promise.all((await listNamedWorkflows(projectId))
    .filter((n) => n.workflow.id === workflowId)
    .map((n) => listWorkflowApprovals(n.id))))
    .flat().filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length))
  for (const branch of new Set(branches)) {
    if (await resolveRemoteRef(repoDir(repoId), branch).catch(() => undefined) === commit) return true
  }
  return false
}

/**
 * The values of the run secrets a launch of `workflowId` gets, when
 * `secrets` (a non-interactive launch or a site's release), with the
 * commit each repo starts at. A repo at a branch runs at its tip, resolved
 * here after a fetch. A person's launch through a named workflow approves
 * each commit for it first. Each repo's commit must pass on its own
 * (docs/workflows.md "The launch check"); a launch with no repos passes.
 * A launch the secrets may not reach is refused rather than run without
 * them.
 */
export async function workflowLaunch(actor: Actor, projectId: string, opts: {
  workflowId: string
  namedWorkflowId?: string
  repos: Array<{ repoId: string; branch?: string; commit?: string }>
  secrets: boolean
}): Promise<{ runSecrets: Record<string, string>; commits?: Record<string, string> }> {
  const workflow = await getWorkflow(opts.workflowId)
  if (workflow?.projectId !== projectId) throw new ServerError('NOT_FOUND', 'that workflow is gone')
  if (!opts.secrets || workflow.secrets.length === 0) return { runSecrets: {} }
  const project = await getProjectRow(projectId)
  const commits: Record<string, string> = {}
  for (const r of opts.repos) {
    if (r.commit !== undefined) {
      commits[r.repoId] = r.commit
      continue
    }
    const main = repoDir(r.repoId)
    const branch = r.branch ?? await getDefaultBranch(main)
    if (!testEnv.e2eSkipFetch) await fetchRepoOrigin(r.repoId)
    commits[r.repoId] = await resolveRemoteRef(main, branch).catch(() => {
      throw new ServerError('VALIDATION', `${dirOf(project, r.repoId)}: branch "${branch}" not found on origin.`)
    })
  }
  if (isPerson(actor) && opts.namedWorkflowId !== undefined) {
    for (const commit of Object.values(commits)) await addWorkflowApproval(opts.namedWorkflowId, commit)
  }
  for (const [repoId, commit] of Object.entries(commits)) {
    if (await workflowApproved(workflow.id, [commit]) || await workflowRanAt(workflow.id, repoId, commit)
      || await approvedTip(workflow.id, projectId, repoId, commit)) continue
    throw new ServerError('FORBIDDEN', 'this workflow is given run secrets, and no person has run it on '
      + `${dirOf(project, repoId)}@${commit.slice(0, 12)}; launch it yourself, or from a routine or site you set up`)
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
  return { runSecrets, commits }
}
