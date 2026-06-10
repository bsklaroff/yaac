import { api } from './apiClient'
import type { SessionTerminalEntry } from '@/shared/types'

/** Terminals a session's container offers beyond the agent view: extra
 *  tmux windows (initCommands dev servers, …) and scratch shells. */
export async function getSessionTerminals(sessionId: string): Promise<SessionTerminalEntry[]> {
  return api.get<SessionTerminalEntry[]>(`/session/${encodeURIComponent(sessionId)}/terminals`)
}

/** Kill a scratch-shell terminal (windows are not closable from the UI). */
export async function closeSessionTerminal(sessionId: string, target: string): Promise<void> {
  await api.post(`/session/${encodeURIComponent(sessionId)}/terminals/close`, { target })
}

/** Next free scratch-shell name given the current list: shell, shell-2, … */
export function nextShellName(existing: SessionTerminalEntry[]): string {
  const names = new Set(existing.filter((e) => e.kind === 'shell').map((e) => e.name))
  if (!names.has('shell')) return 'shell'
  for (let i = 2; ; i++) {
    if (!names.has(`shell-${i}`)) return `shell-${i}`
  }
}
