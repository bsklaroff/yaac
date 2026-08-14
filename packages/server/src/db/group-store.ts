import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { worktreeGroups, worktrees } from './schema'
import { notifyWorktreeListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'
import { normalizeTitle } from '@yaac/shared/titles'

/**
 * Named sidebar groups: how a user has filed a project's worktrees.
 *
 * Pure intent, like titles — nothing observes a group, so every write here is
 * an ordinary UPDATE/INSERT that notifies the snapshot hub itself rather than
 * passing through the worktree-event door. The membership lives on the
 * worktree row (`worktrees.groupId`); this table only names the group and
 * records whether it is pinned.
 *
 * Integrity is this module's, since the schema declares no foreign keys: a
 * move validates its target group (a client can hold a group id the server
 * has already deleted), a delete releases its members rather than orphaning
 * them, and project teardown takes the rows with the project. What is
 * deliberately NOT enforced is emptiness — a group with no live worktree is
 * hidden by the sidebar, not deleted, so restarting a stopped member brings
 * it back exactly as it was.
 */

/** A group row as the display paths consume it. */
export interface WorktreeGroupRow {
  projectSlug: string
  groupId: string
  name: string
  pinned: boolean
  createdAt: Date
}

const key = (projectSlug: string, groupId: string) =>
  and(eq(worktreeGroups.projectSlug, projectSlug), eq(worktreeGroups.groupId, groupId))

/**
 * Create a group, either around a founding worktree or empty.
 *
 * With a founding worktree, both halves land in one transaction and the
 * founding stamp has to have matched: an unpinned, memberless group is
 * listed by nothing and therefore deletable by nothing — it would sit in the
 * table forever. So an unknown worktree (or one belonging to another
 * project) throws, rolling the insert back with it.
 *
 * `null` asks for an empty one, which is what a caller naming a group before
 * it has members needs (`yaac group create`, and `--group` on a create whose
 * worktree does not exist yet). It is born PINNED, because pinning is what
 * keeps a memberless group on screen: without it the user could not see the
 * thing they just made.
 *
 * Pinning is not an invariant, though, and it is worth being exact about
 * what it does and does not guarantee. A group founded around a worktree is
 * unpinned, and nothing re-pins it when that worktree moves out or its row
 * goes away — so a founded group CAN end up empty and unpinned, which the
 * sidebar hides. That is a hidden group, not a stranded one: every group is
 * listed unfiltered (`listWorktreeGroups`), so `yaac group list` shows it
 * and `yaac group delete` removes it, and project teardown reaps it either
 * way. It is left hidden deliberately — a group the user made around a
 * worktree that has since left is noise on screen, not something to
 * resurrect by pinning it for them.
 */
export async function createWorktreeGroup(
  projectSlug: string,
  name: string,
  worktreeId: string | null,
): Promise<WorktreeGroupRow> {
  const groupId = crypto.randomUUID()
  const row: WorktreeGroupRow = {
    projectSlug,
    groupId,
    name: groupName(name),
    pinned: worktreeId === null,
    createdAt: new Date(),
  }
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.insert(worktreeGroups).values(row)
    if (worktreeId === null) return
    const filed = await tx.update(worktrees).set({ groupId })
      .where(and(eq(worktrees.projectSlug, projectSlug), eq(worktrees.worktreeId, worktreeId)))
      .returning({ worktreeId: worktrees.worktreeId })
    if (filed.length === 0) throw unknownWorktree(projectSlug, worktreeId)
  })
  notifyWorktreeListChanged()
  return row
}

/** Rename a group. A blank name keeps the old one — a group is only ever
 *  identified by its name, so there is nothing to fall back to. */
export async function renameWorktreeGroup(
  projectSlug: string,
  groupId: string,
  name: string,
): Promise<void> {
  const normalized = groupName(name)
  if (normalized === '') return
  const db = await getDb()
  await db.update(worktreeGroups).set({ name: normalized }).where(key(projectSlug, groupId))
  notifyWorktreeListChanged()
}

/** Pin (or unpin) a group — whether it stays listed with no live worktree. */
export async function setWorktreeGroupPinned(
  projectSlug: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  const db = await getDb()
  await db.update(worktreeGroups).set({ pinned }).where(key(projectSlug, groupId))
  notifyWorktreeListChanged()
}

/**
 * Delete a group and return its worktrees to the default list — live and
 * stopped alike, in one transaction with the row's removal. Releasing them is
 * what makes the delete safe to offer without a confirmation: nothing is torn
 * down, and every worktree stays exactly where it can be found.
 */
export async function deleteWorktreeGroup(
  projectSlug: string,
  groupId: string,
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(worktrees).set({ groupId: null })
      .where(and(eq(worktrees.projectSlug, projectSlug), eq(worktrees.groupId, groupId)))
    await tx.delete(worktreeGroups).where(key(projectSlug, groupId))
  })
  notifyWorktreeListChanged()
}

/** Every group of a project (or of all projects) — the snapshot's source. */
export async function listWorktreeGroupRows(projectSlug?: string): Promise<WorktreeGroupRow[]> {
  const db = await getDb()
  return projectSlug === undefined
    ? await db.select().from(worktreeGroups)
    : await db.select().from(worktreeGroups)
      .where(eq(worktreeGroups.projectSlug, projectSlug))
}

/**
 * File a worktree under a group, or (with `null`) return it to the default
 * list. The drag-and-drop write, and the only one a client can aim at a group
 * it no longer has: the sidebar acts on a snapshot, and the group may have
 * been deleted between the render and the drop. Both ends are checked, so a
 * move that lands nowhere says so instead of reporting a success that filed
 * nothing.
 */
export async function setWorktreeGroup(
  projectSlug: string,
  worktreeId: string,
  groupId: string | null,
): Promise<void> {
  const db = await getDb()
  if (groupId !== null) {
    const rows = await db.select({ groupId: worktreeGroups.groupId })
      .from(worktreeGroups).where(key(projectSlug, groupId))
    if (rows.length === 0) {
      throw new ServerError('NOT_FOUND', `No such worktree group: ${groupId}`)
    }
  }
  const filed = await db.update(worktrees).set({ groupId })
    .where(and(eq(worktrees.projectSlug, projectSlug), eq(worktrees.worktreeId, worktreeId)))
    .returning({ worktreeId: worktrees.worktreeId })
  if (filed.length === 0) throw unknownWorktree(projectSlug, worktreeId)
  notifyWorktreeListChanged()
}

/**
 * Forget a project's groups. Like `deleteProjectWorktrees`, this is the
 * project going away — a group never outlives the worktrees it files.
 */
export async function deleteProjectWorktreeGroups(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(worktreeGroups).where(eq(worktreeGroups.projectSlug, projectSlug))
}

/** Group names get the same trim/collapse/cap a worktree title does — they
 *  are the same kind of user-typed label in the same sidebar. */
function groupName(name: string): string {
  return normalizeTitle(name)
}

/** Every membership write is scoped to a project, so a worktree from another
 *  one is as unknown as a worktree that never existed. */
function unknownWorktree(projectSlug: string, worktreeId: string): ServerError {
  return new ServerError('NOT_FOUND', `No such worktree in ${projectSlug}: ${worktreeId}`)
}
