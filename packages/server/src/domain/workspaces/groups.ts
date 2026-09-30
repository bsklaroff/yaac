import { createWorkspaceGroup, listWorkspaceGroupRows } from '#db'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceGroupSummary } from '@yaac/shared/types'

/**
 * Every sidebar group in wire form, for the snapshot. Membership is carried
 * on the workspace entries (`groupId`), and the client decides which groups
 * to show, so the two cannot disagree.
 */
export async function listWorkspaceGroups(
  projectFilter?: string,
): Promise<WorkspaceGroupSummary[]> {
  const rows = await listWorkspaceGroupRows(projectFilter)
  return rows.map((r) => ({
    groupId: r.groupId,
    projectSlug: r.projectSlug,
    name: r.name,
    pinned: r.pinned,
    createdAt: formatUtcTimestamp(r.createdAt.getTime()),
  }))
}

export interface ResolvedGroup {
  groupId: string
  name: string
}

/**
 * Resolve a group id or name: exact id first (the sidebar sends ids), then a
 * case-insensitive normalized name. A name matching two groups is refused
 * rather than guessed. Returns the name too, for callers that report it.
 *
 * `create` makes the group if no match exists, for callers naming a new
 * group (`--group` on create, `yaac-mama create --group`, queueing).
 */
export async function resolveGroup(
  projectSlug: string,
  group: string,
  opts: { create?: boolean } = {},
): Promise<ResolvedGroup> {
  const rows = await listWorkspaceGroupRows(projectSlug)
  const byId = rows.find((r) => r.groupId === group)
  if (byId) return { groupId: byId.groupId, name: byId.name }

  const wanted = normalizeTitle(group).toLowerCase()
  const byName = rows.filter((r) => r.name.toLowerCase() === wanted)
  if (byName.length === 1) return { groupId: byName[0].groupId, name: byName[0].name }
  if (byName.length > 1) {
    throw new ServerError(
      'VALIDATION',
      `"${group}" names ${byName.length} groups in ${projectSlug} — pass the group id instead `
      + `(${byName.map((r) => r.groupId).join(', ')})`,
    )
  }

  if (opts.create !== true) {
    throw new ServerError('NOT_FOUND', `No such workspace group in ${projectSlug}: ${group}`)
  }
  if (wanted === '') throw new ServerError('VALIDATION', 'group name must not be blank')
  const created = await createWorkspaceGroup(projectSlug, group, null)
  return { groupId: created.groupId, name: created.name }
}
