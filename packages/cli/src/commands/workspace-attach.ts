import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'

/**
 * `yaac workspace attach|shell`: connect the user's terminal to a workspace
 * over the server's PTY WebSocket, either to its tmux ('native': full tmux
 * chrome, `C-b d` detaches) or to a plain zsh ('shell': no tmux). The id or
 * prefix is resolved first because the socket takes only an exact id.
 */
export async function workspaceAttach(workspaceId: string, target: 'native' | 'shell'): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspaceId } })
  await attachWorkspacePty(resolved.workspaceId, target)
}
