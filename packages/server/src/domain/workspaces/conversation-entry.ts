import { formatUtcTimestamp } from '@yaac/shared/time'
import { modelDisplayName } from '#domain/auth'
import type { ConversationLinkRow, SessionRow } from '#db'
import type { AgentLiveness } from '#drivers/contract'
import type { ObservedWindow } from '#runtime/status'
import type { ConversationEntry, AgentStatus, ListedAgentStatus, SessionEntry } from '@yaac/shared/types'

/** A status in wire form (`ListedAgentStatus`): an ask is `waiting` with a
 *  flag. */
export function listedStatus(status: AgentStatus): { status: ListedAgentStatus; asking?: true } {
  return status === 'asking' ? { status: 'waiting', asking: true } : { status }
}

/**
 * One linked conversation in wire form. Every surface that serializes a link
 * (the list, the stopped listing, the conversations route) uses this, so
 * `lastActiveAt` keeps one format; tsc cannot catch a drift since both are
 * `string`. The model goes out with its catalog display name (e.g.
 * "Opus 5.5").
 */
export function toConversationEntry(l: ConversationLinkRow): ConversationEntry {
  const modelName = l.model !== undefined ? modelDisplayName(l.tool, l.model) : undefined
  return {
    conversationId: l.conversationId,
    tool: l.tool,
    mode: l.mode,
    ordinal: l.ordinal,
    active: l.active,
    ...(l.sessionId !== undefined ? { sessionId: l.sessionId } : {}),
    ...(l.firstPrompt !== undefined ? { prompt: l.firstPrompt } : {}),
    ...(l.model !== undefined ? { model: l.model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    ...(l.lastActiveAt !== undefined
      ? { lastActiveAt: formatUtcTimestamp(l.lastActiveAt.getTime()) }
      : {}),
  }
}

/**
 * One session in wire form, for every surface that lists one. It lives in
 * domain, not `#db`, because it joins the stored row with what the runtime
 * observed just now (docs/layered-server.md): its agent's status, by its
 * window, and whether that window's agent has exited. An exited session
 * waits on the user to resume or close it, in a spell that began when its
 * agent was first seen dead. Its title and prompt fall back to its
 * conversation's own.
 */
export function toSessionEntry(
  s: SessionRow,
  links: ConversationLinkRow[],
  live?: { agents: AgentLiveness[]; windows?: ObservedWindow[] },
): SessionEntry {
  const conversation = s.conversationId === undefined
    ? undefined
    : links.find((l) => l.tool === s.tool && l.conversationId === s.conversationId)
  const model = s.model ?? conversation?.model
  const modelName = model !== undefined ? modelDisplayName(s.tool, model) : undefined
  const title = s.title ?? conversation?.title
  const prompt = s.firstPrompt ?? conversation?.firstPrompt
  const window = live?.windows?.find((w) => w.name === s.window)
  const exited = window?.dead === true
  const agent = exited
    ? { status: 'waiting' as const, waitingSinceMs: window.deadSinceMs }
    : live?.agents.find((a) => a.handle === s.window)
  return {
    sessionId: s.id,
    tool: s.tool,
    mode: s.mode,
    window: s.window,
    permissionMode: s.permissionMode,
    ordinal: s.ordinal,
    ...(s.effort !== undefined ? { effort: s.effort } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(s.conversationId !== undefined ? { conversationId: s.conversationId } : {}),
    ...(agent !== undefined ? listedStatus(agent.status) : {}),
    ...(agent?.waitingSinceMs !== undefined ? { waitingSinceMs: agent.waitingSinceMs } : {}),
    ...(s.waitingSeenBy.length > 0 ? { waitingSeenBy: s.waitingSeenBy } : {}),
    ...(exited ? { exited: true as const } : {}),
  }
}
