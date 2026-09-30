import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'

/**
 * Open a raw zsh in the workspace container over the server's PTY
 * WebSocket ('shell' target: no tmux; exiting the shell returns). Resolved
 * first, as `attach` is: the socket takes only an exact id.
 */
export async function workspaceShell(workspaceId: string): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspaceId } })
  await attachWorkspacePty(resolved.workspaceId, 'shell')
}
