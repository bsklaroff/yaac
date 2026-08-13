import { listWorktreeGroupRows } from '#db'
import { formatUtcTimestamp } from '@yaac/shared/time'
import type { WorktreeGroupSummary } from '@yaac/shared/types'

/**
 * Every sidebar group, projected onto the wire — the snapshot's groups half,
 * beside `listActiveWorktrees`' worktrees half.
 *
 * Unfiltered, and deliberately unjoined: whether a group is *shown* depends on
 * whether it has a live member, and the client holding the worktree list can
 * answer that without the server re-deriving it. Membership travels on the
 * worktree entries (`groupId`), not as a list here, so the two halves can
 * never disagree about which worktree is in which group.
 */
export async function listWorktreeGroups(
  projectFilter?: string,
): Promise<WorktreeGroupSummary[]> {
  const rows = await listWorktreeGroupRows(projectFilter)
  return rows.map((r) => ({
    groupId: r.groupId,
    projectSlug: r.projectSlug,
    name: r.name,
    pinned: r.pinned,
    createdAt: formatUtcTimestamp(r.createdAt.getTime()),
  }))
}
