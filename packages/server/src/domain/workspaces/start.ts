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
import { modelDisplayName } from '#domain/auth'
import { authorizeProject, type Actor } from '#domain/access'
import { recordProjectCreate } from '#db'
import { ServerError } from '@yaac/shared/errors'
import { FULL_COMMIT_PATTERN, graphHasTask, parseStepGraph, type StepGraph } from '@yaac/shared/steps'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

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
  /** Reference branch on `origin`; unnamed is the project's default. */
  branch?: string
  /** A full commit to start at instead of a branch's tip, which leaves the
   *  workspace with no base branch. Not with `branch`. */
  commit?: string
  /** The step graph it starts with in place of the project's init steps,
   *  unparsed; null for none (docs/workspace-steps.md). */
  steps?: unknown
  /** Run `steps` untouched, with no session, and stop when they settle. */
  nonInteractive?: boolean
  /** The non-interactive workspace this one reruns. */
  rerunOf?: string
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
  const { projectId, workspaceId, prompt, title, generatedTitle, branch, commit } = request
  await authorizeProject(principal, projectId)
  const steps = checkStartSteps(request)
  const setup = request.noSession === true ? undefined : await resolveCreate(projectId, {
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
  })
  const session = setup === undefined
    ? undefined
    : { ...setup, id: request.sessionId ?? randomUUID(), ...(prompt !== undefined ? { prompt } : {}) }
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
    await recordProjectCreate(projectId, setup.tool, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
    }, branch)
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
    ...(branch !== undefined ? { branch } : {}),
  }, async (onProgress) => {
    try {
      throwIfProvisionStopped(workspaceId)
      // Containerless keeps no spare pool (`defaultReconcileSteps`), a
      // spare's mounts, fixed at launch, have no volume, and a spare starts
      // the project's init steps at a branch.
      if (request.claimSpare && workspaceDriver().kind !== 'containerless' && volume === undefined
        && steps === undefined && commit === undefined) {
        const claimed = await tryClaimPrewarmed(projectId, workspaceId, session, onProgress, {
          ...(branch !== undefined ? { branch } : {}),
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
        ...(branch !== undefined ? { branch } : {}),
        ...(commit !== undefined ? { commit } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(request.nonInteractive === true ? { nonInteractive: true } : {}),
        ...(request.rerunOf !== undefined ? { rerunOf: request.rerunOf } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(generatedTitle !== undefined ? { generatedTitle } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
        ...(volume !== undefined ? { volumeId: volume.id } : {}),
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
        ...(branch !== undefined ? { branch } : {}),
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

/**
 * Check a start's commit, steps and non-interactive flag, answering its
 * parsed graph: absent runs the project's init steps, null none. A
 * non-interactive workspace brings its own graph, with a step that is not a
 * service (it ends when those settle), and opens no session
 * (docs/workspace-steps.md "Non-interactive workspaces").
 */
export function checkStartSteps(
  request: Pick<StartWorkspaceRequest, 'branch' | 'commit' | 'steps' | 'nonInteractive' | 'noSession'>,
): StepGraph | null | undefined {
  if (request.commit !== undefined && request.branch !== undefined) {
    throw new ServerError('VALIDATION', 'name a branch or a commit, not both')
  }
  if (request.commit !== undefined && !FULL_COMMIT_PATTERN.test(request.commit)) {
    throw new ServerError('VALIDATION', `"${request.commit}" is not a full commit id (40 or 64 hex digits)`)
  }
  let steps: StepGraph | null | undefined
  try {
    steps = request.steps === undefined || request.steps === null ? request.steps : parseStepGraph(request.steps)
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
