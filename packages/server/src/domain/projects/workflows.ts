import {
  addApprovals,
  deleteNamedWorkflow,
  findNamedWorkflow,
  getNamedWorkflow,
  getProjectRow,
  getWorkflow,
  insertNamedWorkflow,
  listApprovals,
  listNamedWorkflows,
  listProjectSites,
  listQueuedWorkspaceRows,
  listRoutineRows,
  listRunSecrets,
  markPersonWritten,
  setInitWorkflows as storeInitWorkflows,
  storeWorkflow,
  updateNamedWorkflow,
  type LaunchSpec,
  type NamedWorkflowRow,
  type ProjectRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { isStepName, NAME_RULE, parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { RepoStart, WorkflowEntry, WorkflowSummary } from '@yaac/shared/types'
import { authorizeProject, isPerson, requirePerson, type Actor } from '#domain/access'
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
 * any number of which are init workflows.
 *
 * Anyone who may write the project, its agents included, may write a
 * workflow and name secrets in it. What a person controls is the launch: a
 * privileged one (docs/workflows.md "Approvals") runs only once each repo
 * it starts with is at a commit a person approved for its spec, the content
 * it runs. A person's own action approves only content a person wrote or
 * was shown; nothing an agent does approves anything. Approvals are keyed
 * by content, so an edit makes a spec with none, and no edit races an
 * approval.
 */

/** What an approved branch of a repo is stored as, beside approved commits. */
function branchRef(repoId: string, branch: string): string {
  return `${repoId}:refs/heads/${branch}`
}

/** A repo of the project by its folder, or its id where it is linked no
 *  more. */
const dirOf = (project: ProjectRow | undefined, repoId: string): string =>
  project?.repos.find((l) => l.repo.id === repoId)?.dir ?? repoId

/** A named workflow without its approvals, as the snapshot carries it. */
function summary(w: NamedWorkflowRow, project: ProjectRow | undefined): WorkflowSummary {
  return {
    id: w.id,
    projectId: w.projectId,
    name: w.name,
    steps: w.workflow.steps,
    secrets: w.workflow.secrets,
    repos: w.workflow.repos.map((r) => dirOf(project, r)),
    init: w.init,
    ...(w.workflow.personWritten ? {} : { writtenByAgent: true as const }),
    createdAt: formatUtcTimestamp(w.createdAt.getTime()),
  }
}

/** A workflow as listed, with what its current workflow is approved on
 *  outside a site. An approved branch of a repo that is not the project's
 *  only one reads `<repo's folder>@<branch>`. */
async function entry(w: NamedWorkflowRow): Promise<WorkflowEntry> {
  const approvals = await listApprovals(w.workflow.id)
  const project = await getProjectRow(w.projectId)
  const links = project?.repos ?? []
  const branches = approvals.flatMap((a) => {
    const m = /^([^:]+):refs\/heads\/(.+)$/.exec(a)
    if (!m) return []
    return [links.length === 1 && links[0].repo.id === m[1] ? m[2] : `${dirOf(project, m[1])}@${m[2]}`]
  })
  return {
    ...summary(w, project),
    approvedCommits: approvals.filter((a) => a !== NO_REPOS && !a.includes('refs/heads/')),
    approvedBranches: branches,
  }
}

/** Every project's named workflows as the snapshot carries them, with no
 *  approvals, so a build costs one query per project rather than per
 *  workflow. */
export async function listWorkflowSummaries(): Promise<WorkflowSummary[]> {
  const rows = await listNamedWorkflows()
  const projects = new Map(await Promise.all([...new Set(rows.map((r) => r.projectId))]
    .map(async (id) => [id, await getProjectRow(id)] as const)))
  return rows.map((w) => summary(w, projects.get(w.projectId)))
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

/** Secrets a workflow may name: run secrets of the project, sorted. */
async function checkSecrets(projectId: string, secrets: string[]): Promise<string[]> {
  if (secrets.length === 0) return []
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
  await authorizeProject(actor, projectId, 'delegate')
  const name = input.name.trim()
  if (!isStepName(name)) throw new ServerError('VALIDATION', `"${name}" is not a workflow name (${NAME_RULE})`)
  const workflow = await storeWorkflow(projectId, {
    steps: checkSteps(input.steps),
    secrets: await checkSecrets(projectId, input.secrets ?? []),
    repos: await projectRepoIds(projectId, input.repos ?? []),
  }, isPerson(actor))
  await insertNamedWorkflow(projectId, name, workflow.id, input.init === true)
  return await showWorkflow(projectId, name)
}

/**
 * Point a named workflow at new content, or mark or unmark it as an init
 * workflow. Content left out stays as it is. The new content is a new spec,
 * so nothing approved for the old one runs it with secrets, and it is a
 * person's only when a person saw its steps.
 */
export async function editWorkflow(actor: Actor, projectId: string, name: string, input: {
  steps?: unknown
  secrets?: string[]
  repos?: string[]
  init?: boolean
}): Promise<WorkflowEntry> {
  await authorizeProject(actor, projectId, 'delegate')
  const row = await resolveWorkflow(projectId, name)
  const content = input.steps !== undefined || input.secrets !== undefined || input.repos !== undefined
  if (!content && input.init === undefined) {
    throw new ServerError('VALIDATION', 'nothing to change: give steps, secrets, repos or init')
  }
  if (!content) {
    await updateNamedWorkflow(row.id, { init: input.init })
    return await showWorkflow(projectId, name)
  }
  // A person's edit makes the content theirs only when they sent the steps,
  // or kept steps a person already wrote: secrets or repos given to an
  // agent's steps leave them the agent's.
  const byPerson = isPerson(actor) && (input.steps !== undefined || row.workflow.personWritten)
  const workflow = await storeWorkflow(projectId, {
    steps: input.steps !== undefined ? checkSteps(input.steps) : row.workflow.steps,
    secrets: input.secrets !== undefined ? await checkSecrets(projectId, input.secrets) : row.workflow.secrets,
    repos: input.repos !== undefined ? await projectRepoIds(projectId, input.repos) : row.workflow.repos,
  }, byPerson)
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
 *  follows it. Deleting an init workflow is how its steps stop running.
 *  Its workflows' approvals stay while anything names them. */
export async function deleteWorkflow(actor: Actor, projectId: string, name: string): Promise<void> {
  await authorizeProject(actor, projectId, 'delegate')
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

/** The spec of a launch of `workflowId` that is not a site's deploy. */
export function workflowSpec(workflowId: string): LaunchSpec {
  return { spec: workflowId, workflowId }
}

/** What a launch with no repos is approved as: its spec alone. */
const NO_REPOS = '-'

/**
 * A privileged launch no person approved (docs/workflows.md "Approvals"),
 * with what it would have run, so a person can be shown exactly that and
 * approve it.
 */
export class ApprovalRequiredError extends ServerError {
  readonly request: { workflowId: string; commits: Record<string, string> }

  constructor(message: string, request: { workflowId: string; commits: Record<string, string> }) {
    super('APPROVAL_REQUIRED', message)
    this.request = request
  }
}

/** Whether a person wrote, or was shown and approved, a workflow's content,
 *  so a person's own action may approve commits for it. */
async function personWrote(workflowId: string): Promise<boolean> {
  return (await getWorkflow(workflowId))?.personWritten === true
}

/**
 * A person approves a workflow's content they were shown, by its id, so
 * what an agent wrote meanwhile is not what they approve: the review of a
 * queued launch or a site's requested deploy.
 */
export async function approveContent(actor: Actor, projectId: string, workflowId: string): Promise<void> {
  requirePerson(actor, 'approve what a launch runs')
  const workflow = await getWorkflow(workflowId)
  if (workflow?.projectId !== projectId) throw new ServerError('NOT_FOUND', 'that workflow is gone')
  await markPersonWritten(workflowId)
}

/** What each repo of a stored start is approved as: its commit, or its
 *  branch of that repo, or the spec alone for a start with none. Stored
 *  selections name repos by id. */
function startRefs(repos: RepoStart[]): string[] {
  if (repos.length === 0) return [NO_REPOS]
  return repos.map((r) => {
    if (r.commit !== undefined) return r.commit
    if (r.branch === undefined) throw new ServerError('VALIDATION', 'a start approved for a launch names a branch or commit per repo')
    return branchRef(r.repo, r.branch)
  })
}

/**
 * A person's action approves each repo's commit or branch of a start it
 * stores (a routine's, a following site's) for `spec`, where a person
 * wrote or approved the spec's workflow; anything else approves nothing,
 * and its launches wait for a person's review.
 */
export async function approveStart(actor: Actor, spec: LaunchSpec, repos: RepoStart[]): Promise<void> {
  if (isPerson(actor) && await personWrote(spec.workflowId)) await addApprovals(spec, startRefs(repos))
}

/** `approveStart` for a routine's start of a named workflow: its current
 *  workflow's spec, when that names secrets, so its runs get them. */
export async function approveWorkflowStart(actor: Actor, namedWorkflowId: string, repos: RepoStart[]): Promise<void> {
  const named = await getNamedWorkflow(namedWorkflowId)
  if (named !== undefined && named.workflow.secrets.length > 0) await approveStart(actor, workflowSpec(named.workflow.id), repos)
}

/** Whether `commit` is now the tip of a branch of `repoId` approved for
 *  `spec`. */
async function approvedTip(spec: string, repoId: string, commit: string): Promise<boolean> {
  const prefix = `${repoId}:refs/heads/`
  const branches = (await listApprovals(spec)).filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length))
  for (const branch of branches) {
    if (await resolveRemoteRef(repoDir(repoId), branch).catch(() => undefined) === commit) return true
  }
  return false
}

/**
 * Admit a privileged launch of `spec` with each repo at a commit (by repo
 * id). A person's launch (`byPerson`) approves its commits, where a person
 * wrote or approved the spec's workflow. Any other passes when each commit is
 * approved for the spec or is the tip of a branch approved for it, or, with
 * no repos, when the spec itself is; what passes is then recorded as
 * approved, so a rerun or replacement repeats it once the branch moves on.
 * Refuses with an `ApprovalRequiredError` carrying what it would run.
 */
export async function admitLaunch(byPerson: boolean, projectId: string, spec: LaunchSpec, commits: Record<string, string>): Promise<void> {
  const refs = Object.keys(commits).length > 0 ? Object.values(commits) : [NO_REPOS]
  const request = { workflowId: spec.workflowId, commits }
  if (!(byPerson && await personWrote(spec.workflowId))) {
    const approved = new Set(await listApprovals(spec.spec))
    const agentWrote = byPerson ? 'its workflow was last written by an agent, so ' : ''
    if (refs[0] === NO_REPOS && !approved.has(NO_REPOS)) {
      throw new ApprovalRequiredError(`${agentWrote}no person has approved this workflow; a person approves it by reviewing it`, request)
    }
    for (const [repoId, commit] of Object.entries(commits)) {
      if (approved.has(commit) || await approvedTip(spec.spec, repoId, commit)) continue
      const project = await getProjectRow(projectId)
      throw new ApprovalRequiredError(`${agentWrote}no person has approved this on ${dirOf(project, repoId)}@${commit.slice(0, 12)}; `
        + 'a person approves it by reviewing it', request)
    }
  }
  await addApprovals(spec, refs)
}

/**
 * The values of the run secrets a launch of `workflowId` gets, when
 * `secrets` (a non-interactive launch or a site's release), with the
 * commit each repo starts at. A repo at a branch runs at its tip, resolved
 * here after a fetch. The launch is admitted for `spec`, the workflow's own
 * unless a site's deploy names its own (`admitLaunch`), as a person's when
 * a person launched it or saved the entry it launches (`personSaved`); a
 * launch with no repos passes once its spec is approved. One no person
 * approved is refused rather than run without the secrets.
 */
export async function workflowLaunch(actor: Actor, projectId: string, opts: {
  workflowId: string
  spec?: LaunchSpec
  repos: Array<{ repoId: string; branch?: string; commit?: string }>
  secrets: boolean
  personSaved?: boolean
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
  await admitLaunch(isPerson(actor) || opts.personSaved === true, projectId, opts.spec ?? workflowSpec(workflow.id), commits)
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
