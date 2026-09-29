import { createWorktree, resolveCreate, type WorktreeCreateResult } from './create'
import { registerProvisioning } from './provisioning'
import { tryClaimPrewarmed } from './prewarm'
import { modelDisplayName } from '#domain/auth'
import { recordProjectCreate } from '#db'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/** One create, as every caller that starts a worktree asks for it. */
export interface StartWorktreeRequest {
  projectSlug: string
  /** The id its provisioning row is registered under — and the worktree's
   *  own, unless a prewarmed spare is claimed in its place. */
  worktreeId: string
  tool?: AgentTool
  model?: string
  permissionMode?: PermissionMode
  mode?: AgentMode
  /** Reference branch on `origin`; unnamed is the project's default. */
  branch?: string
  prompt?: string
  /** Sidebar group, already resolved to an id. */
  groupId?: string
  /** Record what the request named as the project's next create defaults —
   *  for a person choosing, never for an agent or a queued launch. */
  rememberDefaults: boolean
  /** Try a prewarmed spare first. A claimed spare lists under its own id,
   *  not `worktreeId`, so a caller that has already handed that id out (an
   *  agent's `yaac-mama create`, a queued launch whose children now point at
   *  it) passes false. */
  claimSpare: boolean
}

/**
 * Start a worktree: resolve every choice, register its provisioning row,
 * then hand over a prewarmed spare or create one cold.
 *
 * The one create path — the create route, `yaac-mama create` and a queued
 * launch all come through here, each with its own flags. Answers the
 * worktree that resulted, whose id is the spare's when one was claimed.
 */
export async function startWorktree(
  request: StartWorktreeRequest,
  onProgress: (message: string) => void,
): Promise<WorktreeCreateResult> {
  const { projectSlug, worktreeId, groupId, prompt } = request
  // Every choice resolved here, once: what the request named, else what this
  // project last used for that agent, else the fallback — the same answer
  // the webapp's create form shows before submit. An unnamed mode stays
  // `tui`: only the webapp can present a chat pane, and it sends the one it
  // remembers.
  const setup = await resolveCreate(projectSlug, {
    ...(request.tool !== undefined ? { tool: request.tool } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
    ...(request.mode !== undefined ? { mode: request.mode } : {}),
  })
  const { tool } = setup
  if (request.rememberDefaults) {
    // Only the fields the request named are written, so a create that took a
    // resolved default never overwrites a pick — and the agent itself is
    // always recorded, as the one this project was last created with.
    await recordProjectCreate(projectSlug, tool, {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.permissionMode !== undefined ? { permissionMode: request.permissionMode } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
    })
  }

  // Registered before the long await so the row shows up instantly and
  // survives a browser reload.
  const modelName = setup.model !== undefined ? modelDisplayName(tool, setup.model) : undefined
  registerProvisioning({
    worktreeId,
    projectSlug,
    tool,
    kind: 'create',
    ...(groupId !== undefined ? { groupId } : {}),
    ...(setup.model !== undefined ? { model: setup.model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
  })

  if (request.claimSpare) {
    // Spares are warmed as this project's untouched create, so the usual
    // claim hands the running agent over as-is; one warmed with a different
    // agent, model or posture has its agent respawned, and one in the other
    // mode is passed over (see `tryClaimPrewarmed`). A claim returns the
    // spare's own id, which lists in place of this row once it resolves.
    const claimed = await tryClaimPrewarmed(projectSlug, worktreeId, setup, onProgress, {
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
    })
    if (claimed) return claimed
  }

  return await createWorktree(projectSlug, {
    worktreeId,
    onProgress,
    tool,
    mode: setup.mode,
    permissionMode: setup.permissionMode,
    ...(setup.model !== undefined ? { model: setup.model } : {}),
    ...(request.branch !== undefined ? { branch: request.branch } : {}),
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  })
}
