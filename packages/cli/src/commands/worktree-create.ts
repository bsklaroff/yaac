import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureGitIdentity } from '#commands/git-identity'
import { api } from '#commands/api'
import { attachWorktreePty } from '#commands/ws-terminal'
import { isLoopbackOrigin, resolveServerTarget } from '@yaac/shared/server-api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { getProjectsDir } from '@yaac/shared/paths'
import { testEnv } from '@yaac/shared/env'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

export interface WorktreeCreateOptions {
  tool?: AgentTool
  /** Reference branch for the worktree (no `origin/` prefix). Omitted →
   *  the server resolves the project's configured default. */
  branch?: string
  /** Initial prompt typed into the agent pane once the worktree is up. */
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
  /** Sidebar group to file the worktree under, by name (or id). A name
   *  matching no group creates it — the caller is naming a group here, not
   *  picking one from a list they can see. */
  group?: string
  /** Let the server install the agent's CLI when this host hasn't got it,
   *  rather than refusing the create. Only means anything on a server with
   *  no image to supply tools (the containerless driver). */
  installMissing?: boolean
}

interface WorktreeCreateResult {
  worktreeId?: string
  jobName?: string
}

/**
 * CLI entry point for `yaac worktree create`. Prompts for git identity
 * when the global config is missing, then hands provisioning off to
 * the server via `POST /worktree/create`. The server owns the git worktree,
 * Job, and port forwarders for the worktree's lifetime; the CLI just
 * attaches the user's terminal to the resulting tmux session.
 */
export async function worktreeCreate(projectSlug: string, options: WorktreeCreateOptions): Promise<string | undefined> {
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

  // Make sure the server has an identity to commit under, seeding it from
  // this machine's git config — so a create fails here, where a prompt can
  // fix it, rather than inside the server where nothing can.
  if (!await ensureGitIdentity()) {
    process.exitCode = 1
    return
  }

  // Tool is sent only when explicit (--tool). The server resolves the
  // configured default (yaac tool set) when omitted, so a bare create matches
  // the prewarmed spare the server keeps for that tool.
  const res = await api.worktree.create.$post({
    json: {
      project: projectSlug,
      tool: options.tool,
      branch: options.branch,
      prompt: options.prompt,
      model: options.model,
      mode: options.mode,
      permissionMode: options.permissionMode,
      group: options.group,
      installMissingTool: options.installMissing,
    },
  })

  const result = await consumeNdjsonStream<WorktreeCreateResult>(res)

  const { worktreeId, jobName } = result
  if (!worktreeId || !jobName) {
    console.error('Server did not return a worktreeId/jobName.')
    process.exitCode = 1
    return
  }

  // Test-only hook: e2e-cli tests drive worktrees without a TTY, where
  // an interactive attach hangs waiting for terminal capabilities.
  // Setting this env var returns after provisioning and lets the test
  // drive the container directly via `kubectl exec`.
  // An ACP worktree has no TUI to attach to: its agent speaks JSON-RPC, and
  // the conversation lives in the web app's chat pane. Attaching anyway would
  // drop the user into the acpd supervisor's window, which shows only its log.
  if (options.mode === 'acp') {
    console.log(`Worktree ${worktreeId} is running in ACP mode — open it in the web app to chat with the agent.`)
    return worktreeId
  }

  if (!testEnv.e2eNoAttach) {
    try {
      await attachWorktreePty(worktreeId, 'native')
    } catch {
      // Job or tmux session was killed (e.g. ctrl-b k) — the server's
      // background loop will reap the dead worktree.
    }
  }

  return worktreeId
}
