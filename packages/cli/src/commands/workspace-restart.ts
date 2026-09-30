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
 * `yaac workspace restart <id>`: ask the server to restart the workspace,
 * keeping its checkout and resuming every agent session that was live when
 * it stopped, then attach to it.
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

  // As in create: an ACP workspace is used from the web app's chat pane.
  if (mode === 'acp') {
    console.log(`Workspace ${restartedId} is running in ACP mode — open it in the web app to chat with the agent.`)
    return restartedId
  }

  if (!testEnv.e2eNoAttach) {
    try {
      await attachWorkspacePty(restartedId, 'native')
    } catch {
      // The session was killed; the server reaps it.
    }
  }

  return restartedId
}
