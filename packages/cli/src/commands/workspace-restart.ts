import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'
import type { AgentMode } from '@yaac/shared/types'

interface WorkspaceRestartResult {
  workspaceId?: string
  jobName?: string
  mode?: AgentMode
}

/**
 * CLI entry for `yaac workspace restart <id>`. Hands the restart off to
 * the server. The server tears down the old Job, keeps the checkout, and
 * spins up a fresh Job that resumes every agent session which was live when
 * the workspace stopped — each in its own window.
 */
export async function workspaceRestart(workspaceId: string): Promise<string | undefined> {
  const res = await api.workspace.restart.$post({
    json: {
      workspaceId,
    },
  })

  const result = await consumeNdjsonStream<WorkspaceRestartResult>(res)

  const { workspaceId: restartedId, jobName, mode } = result
  if (!restartedId || !jobName) {
    console.error('Server did not return a workspaceId/jobName.')
    process.exitCode = 1
    return
  }

  // Same rule as create: an ACP workspace's agent window runs acpd, so
  // attaching would drop the user into the supervisor's stdio rather than a
  // usable terminal — and sit there until they kill it. The chat pane is the
  // way in.
  if (mode === 'acp') {
    console.log(`Workspace ${restartedId} is running in ACP mode — open it in the web app to chat with the agent.`)
    return restartedId
  }

  if (!testEnv.e2eNoAttach) {
    try {
      await attachWorkspacePty(restartedId, 'native')
    } catch {
      // Job or tmux session was killed — reaper will clean up.
    }
  }

  return restartedId
}
