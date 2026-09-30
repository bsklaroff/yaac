import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'

/**
 * Open a plain zsh in the workspace over the server's PTY WebSocket ('shell'
 * target: no tmux). The id is resolved first because the socket takes only
 * an exact id.
 */
export async function workspaceShell(workspaceId: string): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspaceId } })
  await attachWorkspacePty(resolved.workspaceId, 'shell')
}
