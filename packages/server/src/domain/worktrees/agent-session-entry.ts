import { formatUtcTimestamp } from '@yaac/shared/time'
import type { AgentSessionLinkRow } from '#records'
import type { AgentSessionEntry } from '@yaac/shared/types'

/**
 * One linked conversation as the wire shows it. The single mapper for every
 * surface that serializes a link — the list, the stopped listing, and the
 * agent-sessions route — so `lastActiveAt` can't drift into a second format
 * (tsc cannot catch that: both are `string`).
 *
 * A mediator rather than a records function, because the entry it builds is
 * a join: the row half is recorded, and `live` is what a runtime observed
 * just now. Records speaks rows, and deciding how the two halves combine is
 * this layer's job (docs/layered-server.md) — the same reason the join paths
 * that call this one live here.
 */
export function toAgentSessionEntry(
  l: AgentSessionLinkRow,
  live?: { status: 'running' | 'waiting'; waitingSinceMs?: number },
): AgentSessionEntry {
  return {
    agentSessionId: l.agentSessionId,
    tool: l.tool,
    mode: l.mode,
    ordinal: l.ordinal,
    active: l.active,
    ...(live !== undefined ? { status: live.status } : {}),
    ...(live?.waitingSinceMs !== undefined ? { waitingSinceMs: live.waitingSinceMs } : {}),
    ...(l.firstPrompt !== undefined ? { prompt: l.firstPrompt } : {}),
    ...(l.lastActiveAt !== undefined
      ? { lastActiveAt: formatUtcTimestamp(l.lastActiveAt.getTime()) }
      : {}),
  }
}
