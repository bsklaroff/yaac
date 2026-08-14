import { api } from './api'
import { ServerError } from '@yaac/shared/errors'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'

/**
 * One conversation's history, fetched rather than streamed.
 *
 * The live pane gets its events over a socket, which needs a running
 * workspace; this is the same events over a plain GET, which does not. That is
 * what lets a stopped worktree show what was actually said instead of only the
 * question that started it.
 */

/** A conversation with no readable history — see `transcriptViewable`. */
export const TRANSCRIPT_UNAVAILABLE = Symbol('transcript unavailable')

export type TranscriptResult = AcpEvent[] | typeof TRANSCRIPT_UNAVAILABLE

/**
 * Whether a conversation has a transcript worth asking for.
 *
 * Decided from the row the listing already carries, so a conversation the
 * server would refuse costs no round trip: an `acp` one was recorded as it
 * happened, and a `tui` claude one is replayed from claude's own transcript.
 * Everything else keeps its history somewhere the server cannot read once the
 * worktree is gone — opencode's is a sqlite database inside the container.
 */
export function transcriptViewable(session: AgentSessionEntry): boolean {
  return session.mode === 'acp' || session.tool === 'claude'
}

/**
 * A conversation's events, or `TRANSCRIPT_UNAVAILABLE` when this install
 * cannot produce them.
 *
 * Both refusals degrade to the same answer rather than an error: a 501 is a
 * tool whose history is not readable, and a 404 is an older server that does
 * not serve this route at all (the same version-skew posture the stopped
 * listing takes). Neither is worth a failed pane — the view falls back to the
 * founding prompt.
 */
export async function getSessionTranscript(
  worktreeId: string,
  agentSessionId: string,
): Promise<TranscriptResult> {
  try {
    const { events } = await api.worktree[':id']['agent-sessions'][':sessionId'].transcript.$get({
      param: { id: worktreeId, sessionId: agentSessionId },
    })
    return events
  } catch (err) {
    if (err instanceof ServerError && (err.code === 'NOT_SUPPORTED' || err.code === 'NOT_FOUND')) {
      return TRANSCRIPT_UNAVAILABLE
    }
    throw err
  }
}
