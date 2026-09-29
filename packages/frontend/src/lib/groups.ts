import type { WorktreeGroupSummary } from '@yaac/shared/types'

/** The groups the sidebar lists: pinned ones, and those some `occupant`
 *  (a live, provisioning or held worktree, as the sidebar counts them) is
 *  filed under. */
export function shownGroups(
  groups: WorktreeGroupSummary[],
  occupants: { groupId?: string }[],
): WorktreeGroupSummary[] {
  const occupied = new Set(occupants.map((o) => o.groupId))
  return groups.filter((g) => g.pinned || occupied.has(g.groupId))
}
