import { api } from './api'
import type { WorkspaceTerminalEntry } from '@yaac/shared/types'

/** A workspace's terminals other than the agent: the other windows of its
 *  `yaac` tmux session (init-command dev servers, scratch shells, …). */
export async function getWorkspaceTerminals(workspaceId: string): Promise<WorkspaceTerminalEntry[]> {
  return api.workspace[':id'].terminals.$get({ param: { id: workspaceId } })
}

/** Create a scratch-shell window in the workspace's `yaac` tmux session.
 *  Returns the new entry so a pane can open without waiting for the next
 *  terminals poll. */
export async function createShellTerminal(workspaceId: string): Promise<WorkspaceTerminalEntry> {
  return api.workspace[':id'].terminals.$post({ param: { id: workspaceId } })
}

/** Kill a terminal window and whatever runs in it. The server refuses to
 *  kill the agent window. */
export async function killWorkspaceTerminal(workspaceId: string, target: string): Promise<void> {
  await api.workspace[':id'].terminals.close.$post({ param: { id: workspaceId }, json: { target } })
}
