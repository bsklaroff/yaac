import { api } from './api'
import { ServerError } from '@yaac/shared/errors'
import type { AcpEvent } from '@yaac/shared/acp'
import type { AgentSessionEntry } from '@yaac/shared/types'

/**
 * One conversation's history over a plain GET. The live pane streams events
 * over a socket, which needs a running workspace; this lets a stopped
 * workspace show its conversation too.
 */

/** A conversation with no readable history — see `transcriptViewable`. */
export const TRANSCRIPT_UNAVAILABLE = Symbol('transcript unavailable')

export type TranscriptResult = AcpEvent[] | typeof TRANSCRIPT_UNAVAILABLE

/**
 * Whether the server can return a transcript for this conversation, decided
 * locally to skip a request it would refuse. `acp` conversations are
 * recorded, and claude keeps its own transcript. Other tools keep history
 * where the server can't read it once the workspace is gone.
 */
export function transcriptViewable(session: AgentSessionEntry): boolean {
  return session.mode === 'acp' || session.tool === 'claude'
}

/**
 * A conversation's events, or `TRANSCRIPT_UNAVAILABLE`. A 501 (history not
 * readable for this tool) and a 404 (an older server without this route)
 * both return that instead of an error, and the view shows the first
 * prompt instead.
 */
export async function getSessionTranscript(
  workspaceId: string,
  agentSessionId: string,
): Promise<TranscriptResult> {
  try {
    const { events } = await api.workspace[':id']['agent-sessions'][':sessionId'].transcript.$get({
      param: { id: workspaceId, sessionId: agentSessionId },
    })
    return events
  } catch (err) {
    if (err instanceof ServerError && (err.code === 'NOT_SUPPORTED' || err.code === 'NOT_FOUND')) {
      return TRANSCRIPT_UNAVAILABLE
    }
    throw err
  }
}
