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
  let session = sessions[0]
  if (wanted !== undefined) {
    const exact = sessions.filter((s) => s.sessionId === wanted)
    const matches = exact.length > 0 ? exact : sessions.filter((s) => s.sessionId.startsWith(wanted))
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Workspace ${resolved.workspaceId} has no open session "${wanted}".`
        : `"${wanted}" matches more than one session of workspace ${resolved.workspaceId}; use a longer prefix.`)
    }
    session = matches[0]
  }
  await attachWorkspacePty(resolved.workspaceId, session !== undefined ? `native:${session.window}` : 'native')
}
