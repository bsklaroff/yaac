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
  /** Reference branch for the workspace (no `origin/` prefix). Omitted →
   *  the server resolves the project's configured default. */
  branch?: string
  /** Initial prompt typed into the agent pane once the workspace is up. */
  prompt?: string
  /** Model override for the agent's launch command (`--model <model>`):
   *  an id or alias for claude/codex, `provider/model` for opencode/pi. */
  model?: string
  /** How the agent is driven (default: tui). `acp` has no terminal to attach,
   *  so the CLI prints where to find the conversation instead. */
  mode?: AgentMode
  /** How much the agent may do before it asks. Omitted → the project's last
   *  choice, else the driver's default; the server owns that resolution and
   *  rejects a posture the tool doesn't have. */
  permissionMode?: PermissionMode
  /** Sidebar group to file the workspace under, by name (or id). A name
   *  matching no group creates it — the caller is naming a group here, not
   *  picking one from a list they can see. */
  group?: string
}

interface WorkspaceCreateResult {
  workspaceId?: string
  jobName?: string
}

/**
 * CLI entry point for `yaac workspace create`. Hands provisioning off to
 * the server via `POST /workspace/create`. The server owns the checkout,
 * Job, and port forwarders for the workspace's lifetime; the CLI just
 * attaches the user's terminal to the resulting tmux session.
 */
export async function workspaceCreate(projectSlug: string, options: WorkspaceCreateOptions): Promise<string | undefined> {
  // Local fast-fail on an unknown project slug so the user gets an
  // immediate error instead of a round-trip to the server (and so tests
  // can exercise this path without a running server). The server re-
  // validates.
  //
  // Keyed on the origin being LOOPBACK rather than on the target not being
  // a remote: a local k8s install resolves through `server.json` as well
  // (that is how `yaac cluster install` publishes the in-cluster server),
  // and its projects dir is still this machine's — the pod hostPath-mounts
  // it. What the check must not do is read this machine's disk to answer
  // for a server on another one.
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

  // Each choice is sent only when explicit. The server resolves what is
  // omitted from what this project last used (the agent, then its model and
  // posture), so a bare create runs what the webapp's form would show — and
  // matches the prewarmed spare the server keeps warmed as exactly that.
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

  // Test-only hook: e2e-cli tests drive workspaces without a TTY, where
  // an interactive attach hangs waiting for terminal capabilities.
  // Setting this env var returns after provisioning and lets the test
  // drive the container directly via `kubectl exec`.
  // An ACP workspace has no TUI to attach to: its agent speaks JSON-RPC, and
  // the conversation lives in the web app's chat pane. Attaching anyway would
  // drop the user into the acpd supervisor's window, which shows only its log.
  if (options.mode === 'acp') {
    console.log(`Workspace ${workspaceId} is running in ACP mode — open it in the web app to chat with the agent.`)
    return workspaceId
  }

  if (!testEnv.e2eNoAttach) {
    try {
      await attachWorkspacePty(workspaceId, 'native')
    } catch {
      // Job or tmux session was killed (e.g. ctrl-b k) — the server's
      // background loop will reap the dead workspace.
    }
  }

  return workspaceId
}
