import { api } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'

/**
 * `yaac workspace attach|shell`: connect the user's terminal to a workspace
 * over the server's PTY WebSocket, either to its tmux ('native': full tmux
 * chrome, `C-b d` detaches) or to a plain zsh ('shell': no tmux). The id or
 * prefix is resolved first because the socket takes only an exact id.
 *
 * `attach` opens on a session's window: the one `--session` names, else the
 * workspace's first, else whichever window tmux shows.
 */
export async function workspaceAttach(
  workspaceId: string,
  target: 'native' | 'shell',
  options: { session?: string } = {},
): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspaceId } })
  if (target === 'shell') {
    await attachWorkspacePty(resolved.workspaceId, 'shell')
    return
  }
  const { workspaces } = await api.workspace.list.$get({ query: {} })
  const sessions = workspaces.find((w) => w.workspaceId === resolved.workspaceId)?.sessions ?? []
  const wanted = options.session
  const session = wanted === undefined ? sessions[0]
    : sessions.find((s) => s.sessionId === wanted) ?? sessions.find((s) => s.sessionId.startsWith(wanted))
  if (wanted !== undefined && session === undefined) {
    throw new Error(`Workspace ${resolved.workspaceId} has no open session "${wanted}".`)
  }
  await attachWorkspacePty(resolved.workspaceId, session !== undefined ? `native:${session.window}` : 'native')
}
