/**
 * A user viewing a waiting workspace, which clears that user's unread dot
 * on every client until the workspace next stops needing its owner. Any
 * user may mark: each has their own dot, owner and teammates alike.
 */
import { getWorkspaceRow, recordWaitingSeen } from '#db'
import { readWorkspaceStatus, readWorkspaceWaitingSince } from '#runtime/status'
import { ServerError } from '@yaac/shared/errors'
import type { Principal } from '@yaac/shared/types'

/**
 * Record that `principal` saw the waiting spell that began at
 * `waitingSinceMs` (0 for a spell with no stamp), and answer whether that
 * spell is now the workspace's and recorded seen. A mark for any other
 * spell is ignored: a request can arrive after the spell it names has ended
 * and a new one begun, which nobody has seen.
 */
export async function markWaitingSeen(
  principal: Principal,
  projectId: string,
  workspaceId: string,
  waitingSinceMs: number,
): Promise<boolean> {
  if (!await getWorkspaceRow(projectId, workspaceId)) {
    throw new ServerError('NOT_FOUND', `project ${projectId} has no workspace ${workspaceId}`)
  }
  const status = readWorkspaceStatus(projectId, workspaceId)
  if (status !== 'waiting' && status !== 'asking') return false
  if ((readWorkspaceWaitingSince(projectId, workspaceId) ?? 0) !== waitingSinceMs) return false
  await recordWaitingSeen(projectId, workspaceId, principal.userId)
  return true
}
