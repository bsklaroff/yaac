import { createWorkspace, resolveCreate, type WorkspaceCreateResult } from './create'
import { ensureProvisioning } from './provisioning'
import { tryClaimPrewarmed } from './prewarm'
import { modelDisplayName } from '#domain/auth'
import { recordProjectCreate } from '#db'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/** A request to start a workspace. */
export interface StartWorkspaceRequest {
  projectSlug: string
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
}

/**
 * Start a workspace: resolve settings, register the provisioning row, then
 * claim a spare or create cold. Used by the create route, `yaac-mama create`
 * and queued launches.
 */
export async function startWorkspace(
  request: StartWorkspaceRequest,
  onProgress: (message: string) => void,
): Promise<WorkspaceCreateResult> {
  const { projectSlug, workspaceId, groupId, prompt, title } = request
  const setup = await resolveCreate(projectSlug, {
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
  })
  const { tool } = setup
  if (request.rememberDefaults) {
    // Only the named fields, so a resolved default never overwrites a pick.
    await recordProjectCreate(projectSlug, tool, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
    }, request.branch)
  }

  // `ensure`: the caller may have reserved the row already.
  const modelName = setup.model !== undefined ? modelDisplayName(tool, setup.model) : undefined
  ensureProvisioning({
    workspaceId,
    projectSlug,
    tool,
    kind: 'create',
    ...(groupId !== undefined ? { groupId } : {}),
    ...(setup.model !== undefined ? { model: setup.model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
  })

  if (request.claimSpare) {
    const claimed = await tryClaimPrewarmed(projectSlug, workspaceId, setup, onProgress, {
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
    })
    if (claimed) return claimed
  }

  return await createWorkspace(projectSlug, {
    workspaceId,
    onProgress,
    tool,
    mode: setup.mode,
    permissionMode: setup.permissionMode,
    ...(setup.model !== undefined ? { model: setup.model } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  })
}
