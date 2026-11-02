/**
 * A user viewing a waiting session, or one whose agent exited, which clears
 * that user's unread dot on every client until the session next stops
 * needing its owner. Any user may
 * mark: each has their own dot, owner and teammates alike.
 */
import { getSessionRow, recordSessionWaitingSeen } from '#db'
import { readAgentStatus, readWorkspaceWindows } from '#runtime/status'
import { ServerError } from '@yaac/shared/errors'
import type { Principal } from '@yaac/shared/types'

/**
 * Record that `principal` saw the session's waiting spell that began at
 * `waitingSinceMs`, and answer whether that spell is now the session's and
 * recorded seen. A mark for any other spell is ignored: a request can
 * arrive after the spell it names has ended and a new one begun, which
 * nobody has seen.
 */
export async function markWaitingSeen(
  principal: Principal,
  sessionId: string,
  waitingSinceMs: number,
): Promise<boolean> {
  const session = await getSessionRow(sessionId)
  if (session === undefined) throw new ServerError('NOT_FOUND', `no session ${sessionId}`)
  const window = readWorkspaceWindows(session.projectId, session.workspaceId)?.find((w) => w.name === session.window)
  const agent = readAgentStatus(session.projectId, session.workspaceId, session.window)
  // An exited agent's spell began when it was first seen dead.
  const spell = window?.dead === true
    ? window.deadSinceMs
    : agent !== undefined && (agent.status === 'waiting' || agent.status === 'asking') ? agent.waitingSinceMs ?? 0 : undefined
  if (spell === undefined || spell !== waitingSinceMs) return false
  await recordSessionWaitingSeen(sessionId, principal.userId)
  return true
}
