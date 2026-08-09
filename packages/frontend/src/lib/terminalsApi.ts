import { api } from './api'
import type { WorktreeTerminalEntry } from '@yaac/shared/types'

/** Terminals a worktree's container offers beyond the agent view: the other
 *  windows of the `yaac` tmux worktree (initCommands dev servers, scratch
 *  shells, …). */
export async function getWorktreeTerminals(worktreeId: string): Promise<WorktreeTerminalEntry[]> {
  return api.worktree[':id'].terminals.$get({ param: { id: worktreeId } })
}

/** Create a scratch-shell window in the worktree's `yaac` tmux worktree.
 *  Returns the new entry so a pane can open without waiting for the next
 *  terminals poll. */
export async function createShellTerminal(worktreeId: string): Promise<WorktreeTerminalEntry> {
  return api.worktree[':id'].terminals.$post({ param: { id: worktreeId } })
}

/** Kill a window terminal — and whatever runs in it. The server refuses
 *  the agent window. */
export async function killWorktreeTerminal(worktreeId: string, target: string): Promise<void> {
  await api.worktree[':id'].terminals.close.$post({ param: { id: worktreeId }, json: { target } })
}
