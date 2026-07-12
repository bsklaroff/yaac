import { api } from './apiClient'
import type { SessionAgents } from '@/shared/types'

/** The single layout target a session's sub-agent (Agents) pane uses. */
export const AGENTS_TARGET = 'agents'

/** Whether a layout target is the Agents pane. */
export function isAgentsTarget(target: string): boolean {
  return target === AGENTS_TARGET
}

/** The sub-agent tree for a session — what the coding agent fanned out into. */
export async function getSessionAgents(sessionId: string): Promise<SessionAgents> {
  return api.get<SessionAgents>(`/session/${encodeURIComponent(sessionId)}/agents`)
}

/** Compact human duration for a sub-agent run (e.g. "3.4s", "1m 12s"). */
export function formatAgentDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}
