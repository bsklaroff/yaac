import { createWorktreeGroup, listWorktreeGroupRows } from '#db'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import { ServerError } from '@yaac/shared/errors'
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

/** The group a caller's name or id landed on. */
export interface ResolvedGroup {
  groupId: string
  name: string
}

/**
 * Resolve what a human (or an agent) typed into a group: an exact group
 * id first, then a name match, case-insensitively and under the same
 * normalization a group is stored with.
 *
 * Id-before-name is what lets one route serve both the sidebar — which holds
 * ids and means them exactly — and a person typing "review", whose id is
 * something they have never seen. A name that lands on two groups is refused
 * rather than guessed: both are equally what was asked for, and filing a
 * worktree in the wrong one is silent.
 *
 * The NAME travels back beside the id because every surface that reports a
 * move renders it, and the caller may well have passed an id — the ambiguity
 * error tells it to. This is the one place that knows which row was picked,
 * so no renderer has to echo what was typed or look the name up again.
 *
 * `create` is for the callers that are naming a group rather than picking
 * one (`--group` on a create, `yaac-mama create --group`): the group is
 * theirs to bring into being, and demanding they create it first would make
 * every such call two round trips and a race.
 */
export async function resolveGroup(
  projectSlug: string,
  group: string,
  opts: { create?: boolean } = {},
): Promise<ResolvedGroup> {
  const rows = await listWorktreeGroupRows(projectSlug)
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
    throw new ServerError('NOT_FOUND', `No such worktree group in ${projectSlug}: ${group}`)
  }
  if (wanted === '') throw new ServerError('VALIDATION', 'group name must not be blank')
  const created = await createWorktreeGroup(projectSlug, group, null)
  return { groupId: created.groupId, name: created.name }
}
