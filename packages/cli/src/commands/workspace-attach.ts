import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'

/**
 * Attach the user's terminal to a workspace's tmux over the server's PTY
 * WebSocket ('native' target: full tmux chrome, `C-b d` detaches). The id or
 * prefix is resolved first because the socket takes only an exact id.
 */
export async function workspaceAttach(workspaceId: string): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspaceId } })
  await attachWorkspacePty(resolved.workspaceId, 'native')
}
