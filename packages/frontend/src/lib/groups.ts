import type { WorkspaceGroupSummary } from '@yaac/shared/types'

/** The groups the sidebar lists: pinned ones, plus any holding an `occupant`
 *  (a live or provisioning workspace, or a stopped one that queued
 *  workspaces are waiting on). */
export function shownGroups(
  groups: WorkspaceGroupSummary[],
  occupants: { groupId?: string }[],
): WorkspaceGroupSummary[] {
  const occupied = new Set(occupants.map((o) => o.groupId))
  return groups.filter((g) => g.pinned || occupied.has(g.groupId))
}
