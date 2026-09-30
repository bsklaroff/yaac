import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'

/**
 * Attach the user's terminal to a workspace's tmux over the server's PTY
 * WebSocket ('native' target: full tmux chrome, `C-b d` detaches). What the
 * user typed — an id or its unique prefix — is resolved first, because the
 * socket takes only an exact id; an ambiguous or unknown one fails here with
 * the server's own message.
 */
export async function workspaceAttach(workspaceId: string): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspaceId } })
  await attachWorkspacePty(resolved.workspaceId, 'native')
}
