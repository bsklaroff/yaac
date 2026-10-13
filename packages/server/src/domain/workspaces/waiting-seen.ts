/**
 * The owner viewing a waiting workspace, which clears its unread dot on
 * every client until it next stops needing the user.
 */
import { getWorkspaceRow, recordWaitingSeen } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { readWorkspaceStatus, readWorkspaceWaitingSince } from '#runtime/status'
import { ServerError } from '@yaac/shared/errors'

/**
 * Record that the user saw the waiting spell that began at `waitingSinceMs`
 * (0 for a spell with no stamp), and answer whether that spell is now the
 * workspace's and recorded seen. A mark for any other spell is ignored: a
 * request can arrive after the spell it names has ended and a new one
 * begun, which nobody has seen.
 */
export async function markWaitingSeen(
  principal: Actor,
  projectId: string,
  workspaceId: string,
  waitingSinceMs: number,
): Promise<boolean> {
  await authorizeProject(principal, projectId)
  if (!await getWorkspaceRow(projectId, workspaceId)) {
    throw new ServerError('NOT_FOUND', `project ${projectId} has no workspace ${workspaceId}`)
  }
  const status = readWorkspaceStatus(projectId, workspaceId)
  if (status !== 'waiting' && status !== 'asking') return false
  if ((readWorkspaceWaitingSince(projectId, workspaceId) ?? 0) !== waitingSinceMs) return false
  await recordWaitingSeen(projectId, workspaceId)
  return true
}
