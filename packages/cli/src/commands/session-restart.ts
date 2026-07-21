import { ensureGitIdentity } from '#commands/git-identity'
import { api } from '#commands/api'
import { attachSessionPty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'

interface SessionRestartResult {
  sessionId?: string
  jobName?: string
}

/**
 * CLI entry for `yaac session restart <sessionId>`. Resolves git identity
 * up-front (prompting when missing), then hands the restart off to the
 * server. The server tears down the old Job, keeps the worktree, and
 * spins up a fresh Job running the agent with `--resume`.
 */
export async function sessionRestart(
  sessionId: string,
): Promise<string | undefined> {
  const gitUser = await ensureGitIdentity()
  if (!gitUser) {
    process.exitCode = 1
    return
  }

  const res = await api.session.restart.$post({
    json: {
      sessionId,
      gitUser,
    },
  })

  const result = await consumeNdjsonStream<SessionRestartResult>(res)

  const { sessionId: restartedId, jobName } = result
  if (!restartedId || !jobName) {
    console.error('Server did not return a sessionId/jobName.')
    process.exitCode = 1
    return
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
