import { randomUUID } from 'node:crypto'
import { workspaceDriver } from '#drivers/driver'
import { createWorkspace, resolveCreate, type WorkspaceCreateResult } from './create'
import { saveDraftWorkspace } from './drafts'
import { resolveGroup } from './groups'
import { readGroupRoom, refuseFullGroup } from './group-limits'
import {
  provision,
  ProvisionStoppedError,
  refuseLiveProvision,
  throwIfProvisionStopped,
  type ProvisionRun,
} from './provisioning'
import { tryClaimPrewarmed } from './prewarm'
import { volumeForLaunch } from './volumes'
import { VOLUME_NEED } from './steps'
import { modelDisplayName } from '#domain/auth'
import { authorizeProject, type Actor } from '#domain/access'
import { assertWorkflowRepos, resolveWorkflow, workflowLaunch } from '#domain/projects'
import { getProjectRow, getWorkflow, listWorkspaceRepos, recordProjectCreate, storeWorkflow } from '#db'
import { resolveStart, storedSelection, type StartRequest, type WorkspaceStart } from './checkouts'
import { ServerError } from '@yaac/shared/errors'
import { FULL_COMMIT_PATTERN, graphHasTask, parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import type { AgentMode, AgentOptions, AgentTool, PermissionMode, RepoStart } from '@yaac/shared/types'

/** A request to start a workspace. */
export interface StartWorkspaceRequest {
  projectId: string
  /** The provisioning row's id, and the workspace's unless a spare is
   *  claimed. */
  workspaceId: string
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  /** Effort level, in the tool's words; refused if the model lacks it. */
  effort?: string
  mode?: AgentMode
  /** Refused if the tool lacks one; unnamed ones resolve as a create's. */
  agentOptions?: AgentOptions
  /** What it starts with (`resolveStart`): its repos, by folder or id, each
   *  at a branch on `origin` or a full commit (which leaves that checkout
   *  with no base branch), their layout and its agent's cwd. `branch` and
   *  `commit` name the start of a selection of one repo. Each left out
   *  takes what the project's last create chose. */
  repos?: RepoStart[]
  nested?: boolean
  cwd?: string
  branch?: string
  commit?: string
  /** The step graph it starts with in place of the project's init
   *  workflows, unparsed; null for none (docs/workspace-steps.md). */
  steps?: unknown
  /** Run `steps` untouched, with no session, and stop when they settle. */
  nonInteractive?: boolean
  /** The non-interactive workspace this one reruns. */
  rerunOf?: string
  /** A named workflow, whose current workflow it runs in place of `steps`
   *  (docs/workflows.md). */
  workflow?: string
  /** A workflow it runs again, a rerun's or a replacement's, with the name
   *  it had there. */
  workflowId?: string
  workflowName?: string
  prompt?: string
  /** Its session's id, when the client minted one so it can find what it
   *  opened (`GET /workspace/prompt`) before the snapshot names it. */
  sessionId?: string
  /** Start it with no session, which leaves the agent fields unused. */
  noSession?: boolean
  /** The user's title; given, the workspace is not auto-titled. */
  title?: string
  /** The title generated for the draft or queued entry it is started from,
   *  which heads its provisioning row when there is no `title`. */
  generatedTitle?: string
  /** Sidebar group by id or name. An unknown name is created, once the
   *  other settings have checked out. */
  group?: string
  /** A group id filed under as is, never resolved or created: the group a
   *  queued entry was filed into. One deleted since fails the create. */
  groupId?: string
  /** When the server stops it (docs/routines.md "Timeouts"). */
  deadline?: Date
  /** A volume to mount, by name (docs/workspace-volumes.md). */
  volume?: string
  /** A public site's release: see `WorkspaceCreateOptions`. Its `steps`
   *  may need the `volume` step when it stages one. */
  siteId?: string
  image?: string
  stageVolumeId?: string
  colocateWith?: string
  /** Remember the named settings as project defaults (user creates only). */
  rememberDefaults: boolean
  /** Try a prewarmed spare first. A spare has its own id, so callers that
   *  already handed out `workspaceId` pass false. */
  claimSpare: boolean
  /** Set when a create the user stops should keep its prompt as a draft
   *  (updating draft `id`, if it came from one), and with `onFailure` one
   *  that fails too. Only a caller that can come back to the draft sets
   *  `onFailure`, since each failure otherwise adds another. A queued launch
   *  leaves it unset, since its entry goes back on the queue instead. */
  draft?: { id?: string; onFailure?: boolean }
}

/**
 * Check a start and resolve its first session's settings, then register its
 * provisioning row and return the run that claims a spare or creates cold. A bad setting,
 * or a group at its workspace limit, is refused here, before anything shows. Used by the create route,
 * `yaac-mama create` and queued launches.
 *
 * A create that the user stops before its agent runs, or that fails, is
 * rolled back. Its prompt is all it had worth keeping, so per `draft` it
 * becomes a draft (docs/draft-workspaces.md).
 */
export async function prepareStart(
  principal: Actor,
  request: StartWorkspaceRequest,
): Promise<ProvisionRun<WorkspaceCreateResult>> {
  const { projectId, workspaceId, prompt, title, generatedTitle } = request
  await authorizeProject(principal, projectId)
  if ([request.steps, request.workflow, request.workflowId].filter((g) => g !== undefined).length > 1) {
    throw new ServerError('VALIDATION', 'name steps or a workflow, not both')
  }
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const start = resolveStart(project, request)
  checkStartCommits(start)
  const workflow = await startWorkflow(projectId, request)
  if (workflow !== undefined) {
    await assertWorkflowRepos(projectId, workflow.name !== undefined && workflow.namedWorkflowId !== undefined
      ? `workflow "${workflow.name}"` : 'this workflow', workflow.repos, start.repos.map((r) => r.link.repo.id))
  }
  // A start that gets a workflow's run secrets runs each repo at a commit,
  // which `workflowLaunch` resolves from a branch.
  const flow = workflow !== undefined
    ? await workflowLaunch(principal, projectId, {
      workflowId: workflow.id,
      ...(workflow.namedWorkflowId !== undefined ? { namedWorkflowId: workflow.namedWorkflowId } : {}),
      repos: start.repos.map((r) => ({
        repoId: r.link.repo.id,
        ...(r.commit !== undefined ? { commit: r.commit } : {}),
        ...(r.branch !== undefined ? { branch: r.branch } : {}),
      })),
      secrets: request.nonInteractive === true || request.siteId !== undefined,
    })
    : undefined
  for (const r of start.repos) {
    const commit = flow?.commits?.[r.link.repo.id]
    if (commit === undefined) continue
    r.commit = commit
    delete r.branch
  }
  const selection = storedSelection(start)
  const atCommit = start.repos.some((r) => r.commit !== undefined)
  const setup = request.noSession === true ? undefined : await resolveCreate(projectId, {
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
    ...(request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {}),
  })
  const session = setup === undefined
    ? undefined
    : { ...setup, cwd: start.cwd, id: request.sessionId ?? randomUUID(), ...(prompt !== undefined ? { prompt } : {}) }
  // Before the group and defaults below, so a create refused as a duplicate
  // leaves neither behind.
  refuseLiveProvision(workspaceId)
  const groupId = request.groupId ?? (request.group === undefined
    ? undefined
    : (await resolveGroup(projectId, request.group, { create: true })).groupId)
  // Checked once before the defaults are recorded, and again where the
  // provisioning row takes the slot (docs/workspace-groups.md).
  const room = await readGroupRoom(projectId, groupId)
  refuseFullGroup(room, workspaceId)
  const volume = request.volume !== undefined
    ? await volumeForLaunch(projectId, workspaceId, request.volume)
    : undefined
  if (request.rememberDefaults && setup !== undefined) {
    // Only the named fields, so a resolved default never overwrites a pick.
    // What it starts with resolved from the last create's where unnamed, so
    // recording it changes only what this one named.
    await recordProjectCreate(projectId, setup.tool, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {}),
    }, {
      repos: start.repos.map((r) => ({ repoId: r.link.repo.id, ...(r.branch !== undefined ? { branch: r.branch } : {}) })),
      nested: selection.nested,
      cwd: selection.cwd,
    })
  }

  const modelName = setup?.model !== undefined ? modelDisplayName(setup.tool, setup.model) : undefined
  refuseFullGroup(room, workspaceId)
  return provision({
    workspaceId,
    projectId,
    ...(setup !== undefined ? { tool: setup.tool } : {}),
    kind: 'create',
    ...(groupId !== undefined ? { groupId } : {}),
    ...((title ?? generatedTitle) !== undefined ? { title: title ?? generatedTitle } : {}),
    ...(session !== undefined ? { sessionId: session.id } : {}),
    ...(session?.prompt !== undefined ? { prompt: session.prompt } : {}),
    ...(setup?.model !== undefined ? { model: setup.model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    selection,
  }, async (onProgress) => {
    try {
      throwIfProvisionStopped(workspaceId)
      // Containerless keeps no spare pool (`defaultReconcileSteps`), a
      // spare's mounts, fixed at launch, have no volume, and a spare starts
      // the project's init workflows with each repo at a branch.
      if (request.claimSpare && workspaceDriver().kind !== 'containerless' && volume === undefined
        && workflow === undefined && !atCommit) {
        const claimed = await tryClaimPrewarmed(projectId, workspaceId, session, onProgress, {
          start,
          ...(title !== undefined ? { title } : {}),
          ...(generatedTitle !== undefined ? { generatedTitle } : {}),
          ...(groupId !== undefined ? { groupId } : {}),
          ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
        })
        if (claimed) return claimed
      }

      return await createWorkspace(projectId, {
        workspaceId,
        onProgress,
        ...(session !== undefined ? { session } : {}),
        start,
        ...(workflow !== undefined ? { workflow: { id: workflow.id, steps: workflow.steps, name: workflow.name } } : {}),
        ...(request.nonInteractive === true ? { nonInteractive: true } : {}),
        ...(request.rerunOf !== undefined ? { rerunOf: request.rerunOf } : {}),
        ...(flow !== undefined ? { runSecrets: flow.runSecrets } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(generatedTitle !== undefined ? { generatedTitle } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
        ...(volume !== undefined ? { volumeId: volume.id } : {}),
        ...(request.siteId !== undefined ? { siteId: request.siteId } : {}),
        ...(request.image !== undefined ? { image: request.image } : {}),
        ...(request.stageVolumeId !== undefined ? { stageVolumeId: request.stageVolumeId } : {}),
        ...(request.colocateWith !== undefined ? { colocateWith: request.colocateWith } : {}),
      })
    } catch (err) {
      const { draft } = request
      if (draft === undefined || prompt === undefined || setup === undefined) throw err
      if (!(err instanceof ProvisionStoppedError) && draft.onFailure !== true) throw err
      const settings = {
        prompt,
        tool: setup.tool,
        mode: setup.mode,
        permissionMode: setup.permissionMode,
        ...(setup.model !== undefined ? { model: setup.model } : {}),
        ...(setup.effort !== undefined ? { effort: setup.effort } : {}),
        agentOptions: setup.agentOptions,
        ...selection,
        ...(title !== undefined ? { title } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
      }
      // The draft may have been discarded meanwhile; then save a new one. If
      // no draft can be saved, the create's own error is the one to report.
      const saved = await (draft.id === undefined
        ? saveDraftWorkspace(principal, projectId, settings)
        : saveDraftWorkspace(principal, projectId, settings, draft.id)
          .catch(() => saveDraftWorkspace(principal, projectId, settings)))
        .then(() => true, () => false)
      if (!saved || !(err instanceof Error)) throw err
      // A copy, since concurrent creates can share one error (a shared install
      // or build). It keeps the code, and a plain error's message still
      // classifies as it did (`toErrorBody`).
      const message = `${err.message.replace(/\.$/, '')}; its prompt is kept as a draft`
      throw err instanceof ServerError ? new ServerError(err.code, message) : new Error(message, { cause: err })
    }
  })
}

/** The name of the graph a start brings of its own. A workspace has at most
 *  one, and a chosen name never starts with `_` (docs/workspace-steps.md). */
const OWN_WORKFLOW = '_steps'

/**
 * The workflow a start runs in place of the project's init workflows: one
 * its `steps` make (none for null), a named workflow's current one, or one
 * it runs again, with the name it has in the workspace: a named workflow's,
 * the one it had where it ran before, else `_steps`. Undefined
 * for the project's. Checked as a start's graph; its `<workflow>.<step>`
 * needs can only name its own steps, since nothing runs beside it.
 */
async function startWorkflow(
  projectId: string,
  request: StartWorkspaceRequest,
): Promise<{ id: string; steps: StepGraph; repos: string[]; name: string; namedWorkflowId?: string } | undefined> {
  let flow: { id: string; steps: StepGraph; repos: string[]; name: string; namedWorkflowId?: string } | undefined
  if (request.workflow !== undefined) {
    const named = await resolveWorkflow(projectId, request.workflow)
    checkStartSteps({ ...request, steps: named.workflow.steps })
    flow = { ...named.workflow, name: named.name, namedWorkflowId: named.id }
  } else if (request.workflowId !== undefined) {
    const pinned = await getWorkflow(request.workflowId)
    if (pinned?.projectId !== projectId) throw new ServerError('NOT_FOUND', 'the workflow it ran is gone')
    checkStartSteps({ ...request, steps: pinned.steps })
    flow = { ...pinned, name: request.workflowName ?? OWN_WORKFLOW }
  } else {
    const steps = checkStartSteps(request)
    if (steps === undefined) return undefined
    flow = { ...await storeWorkflow(projectId, { steps: steps ?? {}, secrets: [] }), name: OWN_WORKFLOW }
  }
  for (const [step, spec] of Object.entries(flow.steps)) {
    const foreign = (spec.needs ?? []).find((n) => n.includes('.') && !(n.startsWith(`${flow.name}.`)
      && n.slice(flow.name.length + 1) in flow.steps))
    if (foreign !== undefined) {
      throw new ServerError('VALIDATION', `step "${step}" needs "${foreign}", which is not a step of this workspace`)
    }
  }
  return flow
}

/** Refuse a start naming a commit that is not a full commit id. */
export function checkStartCommits(start: WorkspaceStart): void {
  for (const { link, commit } of start.repos) {
    if (commit !== undefined && !FULL_COMMIT_PATTERN.test(commit)) {
      throw new ServerError('VALIDATION', `${link.dir}: "${commit}" is not a full commit id (40 or 64 hex digits)`)
    }
  }
}

/**
 * What a workspace started with, as a request that starts another the same
 * way: its repos in its layout and its cwd. Each repo starts at the commit
 * its checkout was created at or at its base branch, whichever `prefer`
 * names if the checkout has both.
 */
export async function startOf(
  workspace: { workspaceId: string; cwd: string },
  prefer: 'commit' | 'branch',
): Promise<Required<Pick<StartRequest, 'repos' | 'nested' | 'cwd'>>> {
  const rows = await listWorkspaceRepos(workspace.workspaceId)
  const nested = rows.some((r) => r.path !== '')
  return {
    repos: rows.map((r) => {
      const commit = r.startCommit !== undefined ? { commit: r.startCommit } : undefined
      const branch = r.baseBranch !== undefined ? { branch: r.baseBranch } : undefined
      return { repo: r.repoId, ...(prefer === 'commit' ? commit ?? branch : branch ?? commit) }
    }),
    nested,
    cwd: rows.find((r) => r.path === workspace.cwd && (!nested || r.path !== ''))?.repoId ?? '.',
  }
}

/**
 * Check a start's steps and non-interactive flag, answering its
 * parsed graph: absent runs the project's init workflows, null none. A
 * non-interactive workspace brings its own graph, with a step that is not a
 * service (it ends when those settle), and opens no session
 * (docs/workspace-steps.md "Non-interactive workspaces").
 */
export function checkStartSteps(
  request: Pick<StartWorkspaceRequest, 'steps' | 'nonInteractive' | 'noSession' | 'stageVolumeId'>,
): StepGraph | null | undefined {
  let steps: StepGraph | null | undefined
  try {
    steps = request.steps === undefined || request.steps === null
      ? request.steps
      : parseStepGraph(request.steps, new Set(request.stageVolumeId !== undefined ? [VOLUME_NEED] : []))
  } catch (err) {
    throw new ServerError('VALIDATION', (err as Error).message)
  }
  if (request.nonInteractive !== true) return steps
  if (steps === undefined || steps === null || !graphHasTask(steps)) {
    throw new ServerError('VALIDATION', 'a non-interactive workspace needs its own steps, at least one of them not a service')
  }
  if (request.noSession !== true) throw new ServerError('VALIDATION', 'a non-interactive workspace opens no session')
  return steps
}
