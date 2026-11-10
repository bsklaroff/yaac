import { skipToken, useQuery } from '@tanstack/react-query'
import { fetchFullPrompt } from '#lib/queued'

/**
 * The message a session opens with, for the panes that stand in for its
 * chat until the chat's own copy arrives (docs/agent-modes.md "State").
 * The snapshot cuts prompts short, so a text that may have been cut is
 * swapped for the whole one: one this tab already holds, else one fetched
 * once and cached. Until it arrives the message is `loading`, and is shown
 * as nothing rather than as cut. One that cannot be fetched has no `prompt`:
 * the pane goes on standing in for the chat, without the message.
 */
export interface Opening {
  prompt?: string
  loading?: true
}

/**
 * The whole messages this tab holds, by session id: the ones it opened
 * sessions with, and ones a listing carried uncut, so a pane drawn from a
 * shorter cut (a provisioning row keeps more than a session) needs no fetch.
 */
const known = new Map<string, string>()

/** Note session `sessionId`'s whole opening message. */
export function rememberOpening(sessionId: string, prompt: string): void {
  known.set(sessionId, prompt)
}

/**
 * The sessions this tab has drawn starting, whose chat has not yet seen the
 * agent echo the opening message: a create's pane, or a session's before its
 * agent named its first conversation. Only their chat panes carry the
 * opening message on while they connect; any other would show it until the
 * conversation's history arrives, and then swap it for a later page.
 */
const drawnStarting = new Set<string>()

/** Note that session `sessionId` was drawn starting. */
export function markDrawnStarting(sessionId: string): void {
  drawnStarting.add(sessionId)
}

/** Whether session `sessionId` was drawn starting in this tab. */
export function wasDrawnStarting(sessionId: string): boolean {
  return drawnStarting.has(sessionId)
}

/** Note that session `sessionId`'s conversation has started. */
export function forgetDrawnStarting(sessionId: string): void {
  drawnStarting.delete(sessionId)
}

/**
 * Session `sessionId`'s opening message, from `text`, the snapshot's copy
 * cut at `cutAt` characters. Undefined when there is none.
 */
export function useOpening(sessionId: string | undefined, text: string | undefined, cutAt: number): Opening | undefined {
  // A cut drops a trailing half surrogate pair, so it may be one short.
  const cut = text !== undefined && text.length >= cutAt - 1
  const id = cut ? sessionId : undefined
  const whole = useQuery({
    queryKey: ['opening', id],
    queryFn: id === undefined ? skipToken : () => fetchFullPrompt(id),
    initialData: () => (id === undefined ? undefined : known.get(id)),
    staleTime: Infinity,
  })
  if (text === undefined) return undefined
  if (!cut) {
    if (sessionId !== undefined) rememberOpening(sessionId, text)
    return { prompt: text }
  }
  if (whole.data !== undefined) return { prompt: whole.data }
  return whole.isError ? {} : { loading: true }
}
