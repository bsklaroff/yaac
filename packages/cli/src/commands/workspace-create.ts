import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

export interface WorkspaceCreateOptions {
  tool?: AgentTool
  /**
   * Reference branch, without `origin/`. Defaults to the project's configured
   * branch.
   */
  branch?: string
  /** Initial prompt typed into the agent pane once the workspace is up. */
  prompt?: string
  /**
   * Model override: an id or alias for claude/codex, `provider/model` for
   * opencode/pi.
   */
  model?: string
  /** How the agent is driven; defaults to this project's last choice for
   *  the tool, else acp. See docs/agent-modes.md. */
  mode?: AgentMode
  /**
   * How much the agent may do before it asks. Defaults to the project's last
   * choice, else the driver's default; the server rejects a mode the tool
   * does not support.
   */
  permissionMode?: PermissionMode
  /** Sidebar group, by name or id. An unknown name creates the group. */
  group?: string
}

/**
 * `yaac workspace create`: ask the server to create the workspace, then
 * attach the terminal to its tmux session.
 *
 * Options left unset are omitted so the server fills them from what the
 * project last used, matching the web app's form and the prewarmed spare.
 */
export async function workspaceCreate(projectSlug: string, options: WorkspaceCreateOptions): Promise<void> {
  // Best-effort, so a CLI-only user's workspaces get their zone too.
  await reportDeviceTimeZone().catch(() => {})

  await attachStarted(await api.workspace.create.$post({
    json: {
      project: projectSlug,
      tool: options.tool,
      branch: options.branch,
      prompt: options.prompt,
      model: options.model,
      mode: options.mode,
      permissionMode: options.permissionMode,
      group: options.group,
    },
  }))
}

/**
 * Read a create or restart NDJSON stream, then attach the terminal to the
 * workspace it started. An ACP workspace's conversation is in the web app's
 * chat pane (its tmux window only shows the acpd supervisor's log), and e2e
 * runs have no TTY to attach.
 */
export async function attachStarted(res: Response): Promise<void> {
  const { workspaceId, mode } = await consumeNdjsonStream<{ workspaceId: string; mode: AgentMode }>(res)
  if (mode === 'acp') {
    console.log(`Workspace ${workspaceId} is running in ACP mode — open it in the web app to chat with the agent.`)
  } else if (!testEnv.e2eNoAttach) {
    await attachWorkspacePty(workspaceId, 'native')
  }
}
