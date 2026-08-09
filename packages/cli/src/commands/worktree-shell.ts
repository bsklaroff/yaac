import { attachWorktreePty } from '#commands/ws-terminal'

/**
 * Open a raw zsh in the worktree container over the server's PTY
 * WebSocket ('shell' target: no tmux; exiting the shell returns).
 */
export async function worktreeShell(containerId: string): Promise<void> {
  await attachWorktreePty(containerId, 'shell')
}
