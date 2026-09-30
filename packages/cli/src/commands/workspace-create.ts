import fs from 'node:fs/promises'
import path from 'node:path'
import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { isLoopbackOrigin, resolveServerTarget } from '@yaac/shared/server-api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { getProjectsDir } from '@yaac/shared/paths'
import { testEnv } from '@yaac/shared/env'
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
  /** How the agent is driven (default: tui). See docs/agent-modes.md. */
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

interface WorkspaceCreateResult {
  workspaceId?: string
  jobName?: string
}

/**
 * `yaac workspace create`: ask the server to create the workspace, then
 * attach the terminal to its tmux session.
 *
 * Options left unset are omitted so the server fills them from what the
 * project last used, matching the web app's form and the prewarmed spare.
 */
export async function workspaceCreate(projectSlug: string, options: WorkspaceCreateOptions): Promise<string | undefined> {
  // Fail fast on an unknown project without a server round-trip (tests rely
  // on this path working with no server). Only for a loopback server, whose
  // projects dir is on this disk; that includes a local k8s install, whose
  // pod hostPath-mounts it.
  const target = await resolveServerTarget().catch(() => null)
  if (target === null || isLoopbackOrigin(target.baseUrl)) {
    try {
      await fs.access(path.join(getProjectsDir(), projectSlug))
    } catch {
      console.error(`Project "${projectSlug}" not found. Run "yaac project list" to see available projects.`)
      process.exitCode = 1
      return
    }
  }

  const res = await api.workspace.create.$post({
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
  })

  const result = await consumeNdjsonStream<WorkspaceCreateResult>(res)

  const { workspaceId, jobName } = result
  if (!workspaceId || !jobName) {
    console.error('Server did not return a workspaceId/jobName.')
    process.exitCode = 1
    return
  }

  // An ACP workspace's conversation is in the web app's chat pane; its tmux
  // window only shows the acpd supervisor's log.
  if (options.mode === 'acp') {
    console.log(`Workspace ${workspaceId} is running in ACP mode — open it in the web app to chat with the agent.`)
    return workspaceId
  }

  // e2e-cli tests run without a TTY, where an attach would hang.
  if (!testEnv.e2eNoAttach) {
    try {
      await attachWorkspacePty(workspaceId, 'native')
    } catch {
      // The session was killed (e.g. ctrl-b k); the server reaps it.
    }
  }

  return workspaceId
}
