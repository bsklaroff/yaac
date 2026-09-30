import type { WorkspaceGroupSummary } from '@yaac/shared/types'

/** The groups the sidebar lists: pinned ones, and those some `occupant`
 *  (a live, provisioning or held workspace, as the sidebar counts them) is
 *  filed under. */
export function shownGroups(
  groups: WorkspaceGroupSummary[],
  occupants: { groupId?: string }[],
): WorkspaceGroupSummary[] {
  const occupied = new Set(occupants.map((o) => o.groupId))
  return groups.filter((g) => g.pinned || occupied.has(g.groupId))
}
