import { attachSessionPty } from '@/commands/ws-terminal'

/**
 * Attach the user's terminal to a session's tmux over the daemon's PTY
 * WebSocket ('native' target: full tmux chrome, `C-b d` detaches). The
 * daemon resolves the id and reports "not found / not running" over the
 * socket, so no separate lookup round-trip is needed.
 */
export async function sessionAttach(containerId: string): Promise<void> {
  await attachSessionPty(containerId, 'native')
}
