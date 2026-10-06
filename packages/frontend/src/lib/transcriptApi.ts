import { api } from './api'
import { ServerError } from '@yaac/shared/errors'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * One conversation's history over a plain GET. The live pane streams events
 * over a socket, which needs a running workspace; this lets a stopped
 * workspace show its conversation too.
 */

/** A conversation the server has no record of. */
export const TRANSCRIPT_UNAVAILABLE = Symbol('transcript unavailable')

export type TranscriptResult = AcpEvent[] | typeof TRANSCRIPT_UNAVAILABLE

/**
 * A conversation's events, or `TRANSCRIPT_UNAVAILABLE` for a 404 (a
 * conversation the server has no record of), in which case the view shows
 * the first prompt instead.
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
    if (err instanceof ServerError && err.code === 'NOT_FOUND') {
      return TRANSCRIPT_UNAVAILABLE
    }
    throw err
  }
}
