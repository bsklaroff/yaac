import { api } from '#commands/api'
import { attachWorktreePty } from '#commands/ws-terminal'

/**
 * Open a raw zsh in the worktree container over the server's PTY
 * WebSocket ('shell' target: no tmux; exiting the shell returns). Resolved
 * first, as `attach` is: the socket takes only an exact id.
 */
export async function worktreeShell(worktreeId: string): Promise<void> {
  const resolved = await api.worktree[':id'].$get({ param: { id: worktreeId } })
  await attachWorktreePty(resolved.worktreeId, 'shell')
}
