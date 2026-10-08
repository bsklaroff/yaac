import { createWorkspace, resolveCreate, type WorkspaceCreateResult } from './create'
import { saveDraftWorkspace } from './drafts'
import { ensureProvisioning, ProvisionStoppedError, throwIfProvisionStopped } from './provisioning'
import { tryClaimPrewarmed } from './prewarm'
import { modelDisplayName } from '#domain/auth'
import { authorizeProject, type Actor } from '#domain/access'
import { recordProjectCreate } from '#db'
import { ServerError } from '@yaac/shared/errors'
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
  mode?: AgentMode
  /** Reference branch on `origin`; unnamed is the project's default. */
  branch?: string
  prompt?: string
  /** The user's title; given, the workspace is not auto-titled. */
  title?: string
  /** Sidebar group, already resolved to an id. */
  groupId?: string
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
 * Start a workspace: resolve settings, register the provisioning row, then
 * claim a spare or create cold. Used by the create route, `yaac-mama create`
 * and queued launches.
 *
 * A create that the user stops before its agent runs, or that fails, is
 * rolled back. Its prompt is all it had worth keeping, so per `draft` it
 * becomes a draft (docs/draft-workspaces.md).
 */
export async function startWorkspace(
  principal: Actor,
  request: StartWorkspaceRequest,
  onProgress: (message: string) => void,
): Promise<WorkspaceCreateResult> {
  const { projectId, workspaceId, groupId, prompt, title, branch } = request
  await authorizeProject(principal, projectId)
  const setup = await resolveCreate(projectId, {
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
  })
  const { tool } = setup
  if (request.rememberDefaults) {
    // Only the named fields, so a resolved default never overwrites a pick.
    await recordProjectCreate(projectId, tool, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
    }, branch)
  }

  // `ensure`: the caller may have reserved the row already.
  const modelName = setup.model !== undefined ? modelDisplayName(tool, setup.model) : undefined
  ensureProvisioning({
    workspaceId,
    projectId,
    tool,
    kind: 'create',
    ...(groupId !== undefined ? { groupId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(setup.model !== undefined ? { model: setup.model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    ...(branch !== undefined ? { branch } : {}),
  })

  try {
    throwIfProvisionStopped(workspaceId)
    if (request.claimSpare) {
      const claimed = await tryClaimPrewarmed(projectId, workspaceId, setup, onProgress, {
        ...(branch !== undefined ? { branch } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
      })
      if (claimed) return claimed
    }

    return await createWorkspace(projectId, {
      workspaceId,
      onProgress,
      tool,
      mode: setup.mode,
      permissionMode: setup.permissionMode,
      ...(setup.model !== undefined ? { model: setup.model } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
    })
  } catch (err) {
    const { draft } = request
    if (draft === undefined || prompt === undefined) throw err
    if (!(err instanceof ProvisionStoppedError) && draft.onFailure !== true) throw err
    const settings = {
      prompt,
      tool,
      mode: setup.mode,
      permissionMode: setup.permissionMode,
      ...(setup.model !== undefined ? { model: setup.model } : {}),
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
}
