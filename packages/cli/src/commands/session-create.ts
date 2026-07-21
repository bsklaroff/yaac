import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureGitIdentity } from '#commands/git-identity'
import { api } from '#commands/api'
import { attachSessionPty } from '#commands/ws-terminal'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { getProjectsDir } from '@yaac/shared/paths'
import { testEnv } from '@yaac/shared/env'
import type { AgentTool } from '@yaac/shared/types'

export interface SessionCreateOptions {
  tool?: AgentTool
  /** Reference branch for the worktree (no `origin/` prefix). Omitted →
   *  the server resolves the project's configured default. */
  branch?: string
  /** Initial prompt typed into the agent pane once the session is up. */
  prompt?: string
  /** Model override for the agent's launch command (`--model <model>`):
   *  an id or alias for claude/codex, `provider/model` for opencode/pi. */
  model?: string
}

interface SessionCreateResult {
  sessionId?: string
  jobName?: string
}

/**
 * CLI entry point for `yaac session create`. Prompts for git identity
 * when the global config is missing, then hands provisioning off to
 * the server via `POST /session/create`. The server owns the worktree,
 * Job, and port forwarders for the session's lifetime; the CLI just
 * attaches the user's terminal to the resulting tmux session.
 */
export async function sessionCreate(projectSlug: string, options: SessionCreateOptions): Promise<string | undefined> {
  // Local fast-fail on an unknown project slug so the user gets an
  // immediate error instead of a round-trip to the server (and so tests
  // can exercise this path without a running server). The server re-
  // validates. Skipped against a remote server — the projects dir lives
  // on the server host, not this machine.
  const target = await resolveServerTarget().catch(() => null)
  if (!target?.remote) {
    try {
      await fs.access(path.join(getProjectsDir(), projectSlug))
    } catch {
      console.error(`Project "${projectSlug}" not found. Run "yaac project list" to see available projects.`)
      process.exitCode = 1
      return
    }
  }

  // Resolve git identity locally so we can prompt when it's missing.
  // The server gets the already-resolved pair.
  const gitUser = await ensureGitIdentity()
  if (!gitUser) {
    process.exitCode = 1
    return
  }

  // Tool is sent only when explicit (--tool). The server resolves the
  // configured default (yaac tool set) when omitted, so a bare create matches
  // the prewarmed spare the server keeps for that tool.
  const res = await api.session.create.$post({
    json: {
      project: projectSlug,
      tool: options.tool,
      branch: options.branch,
      gitUser,
      prompt: options.prompt,
      model: options.model,
    },
  })

  const result = await consumeNdjsonStream<SessionCreateResult>(res)

  const { sessionId, jobName } = result
  if (!sessionId || !jobName) {
    console.error('Server did not return a sessionId/jobName.')
    process.exitCode = 1
    return
  }

  // Test-only hook: e2e-cli tests drive sessions without a TTY, where
  // an interactive attach hangs waiting for terminal capabilities.
  // Setting this env var returns after provisioning and lets the test
  // drive the container directly via `kubectl exec`.
  if (!testEnv.e2eNoAttach) {
    try {
      await attachSessionPty(sessionId, 'native')
    } catch {
      // Job or tmux session was killed (e.g. ctrl-b k) — the server's
      // background loop will reap the dead session.
    }
  }

  return sessionId
}
