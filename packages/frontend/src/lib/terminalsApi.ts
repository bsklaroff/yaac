import { api } from './api'
import type { SessionTerminalEntry } from '@yaac/shared/types'

/** Terminals a session's container offers beyond the agent view: the other
 *  windows of the `yaac` tmux session (initCommands dev servers, scratch
 *  shells, …). */
export async function getSessionTerminals(worktreeId: string): Promise<SessionTerminalEntry[]> {
  return api.worktree[':id'].terminals.$get({ param: { id: worktreeId } })
}

/** Create a scratch-shell window in the session's `yaac` tmux session.
 *  Returns the new entry so a pane can open without waiting for the next
 *  terminals poll. */
export async function createShellTerminal(worktreeId: string): Promise<SessionTerminalEntry> {
  return api.worktree[':id'].terminals.$post({ param: { id: worktreeId } })
}

/** Kill a window terminal — and whatever runs in it. The server refuses
 *  the agent window. */
export async function killSessionTerminal(worktreeId: string, target: string): Promise<void> {
  await api.worktree[':id'].terminals.close.$post({ param: { id: worktreeId }, json: { target } })
}
