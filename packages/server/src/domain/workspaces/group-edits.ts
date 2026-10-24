/**
 * Group writes that change how many live workspaces a group may hold or does
 * hold, so they check its workspace limit or launch what was waiting for room
 * (docs/workspace-groups.md). Callers authorize the project first.
 */
import { readGroupRoom, refuseFullGroup, reserveGroupSlot } from './group-limits'
import { startWaitingWorkspaces } from './queued-workspaces'
import { inFlightWorkspaceIds } from './provisioning'
import { deleteWorkspaceGroup, getWorkspaceRow, setWorkspaceGroup, setWorkspaceGroupLimit } from '#db'

/**
 * File a workspace under a group, or ungroup it (`null`). A live workspace
 * takes a slot in its new group, so one at its limit refuses it; a stopped
 * one moves freely. Leaving a group frees a slot there.
 */
export async function moveWorkspaceToGroup(projectId: string, workspaceId: string, groupId: string | null): Promise<void> {
  const row = await getWorkspaceRow(projectId, workspaceId)
  const live = row?.stoppedAt === undefined || inFlightWorkspaceIds(Date.now()).includes(workspaceId)
  const room = live ? await readGroupRoom(projectId, groupId ?? undefined) : undefined
  if (room !== undefined) {
    refuseFullGroup(room, workspaceId)
    // Held until the row moves, so a concurrent entry counts it.
    const freeSlot = reserveGroupSlot(projectId, room.groupId, workspaceId)
    try {
      await setWorkspaceGroup(projectId, workspaceId, groupId)
    } finally {
      freeSlot()
    }
  } else {
    await setWorkspaceGroup(projectId, workspaceId, groupId)
  }
  if (live) await startWaitingWorkspaces(projectId)
}

/** Set or clear a group's workspace limit. Lowering it stops nothing; raising
 *  or clearing it launches what was waiting for the room. */
export async function setGroupWorkspaceLimit(projectId: string, groupId: string, workspaceLimit: number | null): Promise<void> {
  await setWorkspaceGroupLimit(projectId, groupId, workspaceLimit)
  await startWaitingWorkspaces(projectId)
}

/** Delete a group. Its waiting entries move to the default list, which has
 *  no limit, so they launch. */
export async function removeWorkspaceGroup(projectId: string, groupId: string): Promise<void> {
  await deleteWorkspaceGroup(projectId, groupId)
  await startWaitingWorkspaces(projectId)
}
