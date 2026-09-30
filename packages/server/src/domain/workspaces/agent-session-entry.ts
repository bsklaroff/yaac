import { formatUtcTimestamp } from '@yaac/shared/time'
import { modelDisplayName } from '#domain/auth'
import type { AgentSessionLinkRow } from '#db'
import type { AgentSessionEntry } from '@yaac/shared/types'

/**
 * One linked conversation in wire form. Every surface that serializes a link
 * (the list, the stopped listing, the agent-sessions route) uses this, so
 * `lastActiveAt` keeps one format; tsc cannot catch a drift since both are
 * `string`.
 *
 * It lives in domain, not `#db`, because it joins the stored row with `live`,
 * what the runtime observed just now (docs/layered-server.md). The model goes
 * out with its catalog display name (e.g. "Opus 5.5").
 */
export function toAgentSessionEntry(
  l: AgentSessionLinkRow,
  live?: { status: 'running' | 'waiting'; waitingSinceMs?: number },
): AgentSessionEntry {
  const modelName = l.model !== undefined ? modelDisplayName(l.tool, l.model) : undefined
  return {
    agentSessionId: l.agentSessionId,
    tool: l.tool,
    mode: l.mode,
    ordinal: l.ordinal,
    active: l.active,
    ...(live !== undefined ? { status: live.status } : {}),
    ...(live?.waitingSinceMs !== undefined ? { waitingSinceMs: live.waitingSinceMs } : {}),
    ...(l.firstPrompt !== undefined ? { prompt: l.firstPrompt } : {}),
    ...(l.model !== undefined ? { model: l.model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    ...(l.lastActiveAt !== undefined
      ? { lastActiveAt: formatUtcTimestamp(l.lastActiveAt.getTime()) }
      : {}),
  }
}
