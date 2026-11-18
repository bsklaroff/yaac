import {
  countStoppedWorkspaces,
  createWorkspaceGroup,
  listWorkspaceGroupRows,
  type StoppedCount,
  type WorkspaceGroupRow,
} from '#db'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
import type { GroupOwnerKind, WorkspaceGroupSummary } from '@yaac/shared/types'

/**
 * Every sidebar group in wire form, for the snapshot. Membership is carried
 * on the workspace entries (`groupId`), and the client decides which groups
 * to show, so the two cannot disagree. The snapshot passes in the stopped
 * counts it shares with `listProjects`, so the count query runs once.
 */
export async function listWorkspaceGroups(
  projectFilter?: string,
  stoppedCounts: Promise<StoppedCount[]> = countStoppedWorkspaces(),
): Promise<WorkspaceGroupSummary[]> {
  const [rows, counts] = await Promise.all([listWorkspaceGroupRows(projectFilter), stoppedCounts])
  return rows.map((r) => {
    const stopped = counts.find((c) => c.projectId === r.projectId && c.groupId === r.groupId)
    return {
      groupId: r.groupId,
      projectId: r.projectId,
      name: r.name,
      ...(r.ownerKind !== null && r.ownerId !== null ? { owner: { kind: r.ownerKind, id: r.ownerId } } : {}),
      pinned: r.pinned,
      ...(r.workspaceLimit !== null ? { workspaceLimit: r.workspaceLimit } : {}),
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      stoppedCount: stopped?.stopped ?? 0,
      deaths: stopped?.deaths ?? 0,
      deathsSeenBy: stopped?.deathsSeenBy ?? {},
    }
  })
}

export interface ResolvedGroup {
  groupId: string
  name: string
  /** Absent when unlimited. */
  workspaceLimit?: number
}

/**
 * Resolve a group id or name: exact id first (the sidebar sends ids), then a
 * case-insensitive normalized name among the groups no object owns. A name
 * matching two groups is refused rather than guessed. Returns the name too,
 * for callers that report it.
 *
 * `create` makes the group if no match exists, for callers naming a new
 * group (`--group` on create, `yaac-mama create --group`, queueing).
 */
export async function resolveGroup(
  projectId: string,
  group: string,
  opts: { create?: boolean } = {},
): Promise<ResolvedGroup> {
  const rows = await listWorkspaceGroupRows(projectId)
  const resolved = (r: WorkspaceGroupRow): ResolvedGroup => ({
    groupId: r.groupId,
    name: r.name,
    ...(r.workspaceLimit !== null ? { workspaceLimit: r.workspaceLimit } : {}),
  })
  const byId = rows.find((r) => r.groupId === group)
  if (byId) return resolved(byId)

  // A group a workflow, routine or site owns is reached by id, as the
  // sidebar addresses it: its name is its owner's, and may be a person's
  // group's too.
  const wanted = normalizeTitle(group).toLowerCase()
  const byName = rows.filter((r) => r.ownerKind === null && r.name.toLowerCase() === wanted)
  if (byName.length === 1) return resolved(byName[0])
  if (byName.length > 1) {
    throw new ServerError(
      'VALIDATION',
      `"${group}" names ${byName.length} groups in ${projectId} — pass the group id instead `
      + `(${byName.map((r) => r.groupId).join(', ')})`,
    )
  }

  if (opts.create !== true) {
    throw new ServerError('NOT_FOUND', `No such workspace group in ${projectId}: ${group}`)
  }
  if (wanted === '') throw new ServerError('VALIDATION', 'group name must not be blank')
  const created = await createWorkspaceGroup(projectId, group, null)
  return { groupId: created.groupId, name: created.name }
}

/**
 * The group a named workflow's, routine's or site's runs go in, made
 * under the owner's name the first time (docs/workspace-groups.md "Owned
 * groups"). Found by its owner rather than by name, so a person's group of
 * the same name is never taken over and a rename of either moves nothing.
 */
export async function ownedGroup(
  projectId: string,
  owner: { kind: GroupOwnerKind; id: string },
  name: string,
): Promise<string> {
  const found = (await listWorkspaceGroupRows(projectId)).find((r) => r.ownerKind === owner.kind && r.ownerId === owner.id)
  return found?.groupId ?? (await createWorkspaceGroup(projectId, name, null, owner)).groupId
}
