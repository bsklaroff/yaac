import { api } from './apiClient'
import type { SessionTerminalEntry } from '@/shared/types'

/** Terminals a session's container offers beyond the agent view: the other
 *  windows of the `yaac` tmux session (initCommands dev servers, scratch
 *  shells, …). */
export async function getSessionTerminals(sessionId: string): Promise<SessionTerminalEntry[]> {
  return api.get<SessionTerminalEntry[]>(`/session/${encodeURIComponent(sessionId)}/terminals`)
}

/** Create a scratch-shell window in the session's `yaac` tmux session.
 *  Returns the new entry so a pane can open without waiting for the next
 *  terminals poll. */
export async function createShellTerminal(sessionId: string): Promise<SessionTerminalEntry> {
  return api.post<SessionTerminalEntry>(`/session/${encodeURIComponent(sessionId)}/terminals`)
}

/** Kill a window terminal — and whatever runs in it. The server refuses
 *  the agent window. */
export async function killSessionTerminal(sessionId: string, target: string): Promise<void> {
  await api.post(`/session/${encodeURIComponent(sessionId)}/terminals/close`, { target })
}
