import { ensureGitIdentity } from '#commands/git-identity'
import { api } from '#commands/api'
import { attachSessionPty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'
import type { AgentMode } from '@yaac/shared/types'

interface WorktreeRestartResult {
  worktreeId?: string
  jobName?: string
  mode?: AgentMode
}

/**
 * CLI entry for `yaac worktree restart <id>`. Resolves git identity
 * up-front (prompting when missing), then hands the restart off to the
 * server. The server tears down the old Job, keeps the git worktree, and
 * spins up a fresh Job that resumes every agent session which was live when
 * the worktree stopped — each in its own window.
 */
export async function worktreeRestart(worktreeId: string): Promise<string | undefined> {
  const gitUser = await ensureGitIdentity()
  if (!gitUser) {
    process.exitCode = 1
    return
  }

  const res = await api.worktree.restart.$post({
    json: {
      worktreeId,
      gitUser,
    },
  })

  const result = await consumeNdjsonStream<WorktreeRestartResult>(res)

  const { worktreeId: restartedId, jobName, mode } = result
  if (!restartedId || !jobName) {
    console.error('Server did not return a worktreeId/jobName.')
    process.exitCode = 1
    return
  }

  // Same rule as create: an ACP worktree's agent window runs acpd, so
  // attaching would drop the user into the supervisor's stdio rather than a
  // usable terminal — and sit there until they kill it. The chat pane is the
  // way in.
  if (mode === 'acp') {
    console.log(`Worktree ${restartedId} is running in ACP mode — open it in the web app to chat with the agent.`)
    return restartedId
  }

  if (!testEnv.e2eNoAttach) {
    try {
      await attachSessionPty(restartedId, 'native')
    } catch {
      // Job or tmux session was killed — reaper will clean up.
    }
  }

  return restartedId
}
