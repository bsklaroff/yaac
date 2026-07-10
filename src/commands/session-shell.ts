import { attachSessionPty } from '@/commands/ws-terminal'

/**
 * Open a raw zsh in the session container over the server's PTY
 * WebSocket ('shell' target: no tmux; exiting the shell returns).
 */
export async function sessionShell(containerId: string): Promise<void> {
  await attachSessionPty(containerId, 'shell')
}
