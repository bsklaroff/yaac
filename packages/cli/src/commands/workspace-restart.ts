import { api } from '#commands/api'
import { attachStarted } from '#commands/workspace-create'

/**
 * `yaac workspace restart <id>`: ask the server to restart the workspace,
 * keeping its checkout and resuming every agent session that was live when
 * it stopped, then attach to it.
 */
export async function workspaceRestart(workspaceId: string): Promise<void> {
  await attachStarted(await api.workspace.restart.$post({ json: { workspaceId } }))
}
