import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { draftWorkspaces, queuedWorkspaces, workspaceGroups, workspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'
import { normalizeTitle } from '@yaac/shared/titles'

/**
 * Named sidebar groups: how a user has filed a project's workspaces.
 *
 * Pure intent, like titles — nothing observes a group, so every write here is
 * an ordinary UPDATE/INSERT that notifies the snapshot hub itself rather than
 * passing through the workspace-event door. The membership lives on the
 * workspace row (`workspaces.groupId`); this table only names the group and
 * records whether it is pinned.
 *
 * Integrity is this module's, since the schema declares no foreign keys: a
 * move validates its target group (a client can hold a group id the server
 * has already deleted), a delete releases its members rather than orphaning
 * them, and project teardown takes the rows with the project. What is
 * deliberately NOT enforced is emptiness — a group with no live workspace is
 * hidden by the sidebar, not deleted, so restarting a stopped member brings
 * it back exactly as it was.
 */

/** A group row as the display paths consume it. */
export interface WorkspaceGroupRow {
  projectSlug: string
  groupId: string
  name: string
  pinned: boolean
  createdAt: Date
}

const key = (projectSlug: string, groupId: string) =>
  and(eq(workspaceGroups.projectSlug, projectSlug), eq(workspaceGroups.groupId, groupId))

/**
 * Create a group, either around a founding workspace or empty.
 *
 * With a founding workspace, both halves land in one transaction and the
 * founding stamp has to have matched: an unpinned, memberless group is
 * listed by nothing and therefore deletable by nothing — it would sit in the
 * table forever. So an unknown workspace (or one belonging to another
 * project) throws, rolling the insert back with it.
 *
 * `null` asks for an empty one, which is what a caller naming a group before
 * it has members needs (`yaac group create`, and `--group` on a create whose
 * workspace does not exist yet). It is born PINNED, because pinning is what
 * keeps a memberless group on screen: without it the user could not see the
 * thing they just made.
 *
 * Pinning is not an invariant, though, and it is worth being exact about
 * what it does and does not guarantee. A group founded around a workspace is
 * unpinned, and nothing re-pins it when that workspace moves out or its row
 * goes away — so a founded group CAN end up empty and unpinned, which the
 * sidebar hides. That is a hidden group, not a stranded one: every group is
 * listed unfiltered (`listWorkspaceGroups`), so `yaac group list` shows it
 * and `yaac group delete` removes it, and project teardown reaps it either
 * way. It is left hidden deliberately — a group the user made around a
 * workspace that has since left is noise on screen, not something to
 * resurrect by pinning it for them.
 */
export async function createWorkspaceGroup(
  projectSlug: string,
  name: string,
  workspaceId: string | null,
): Promise<WorkspaceGroupRow> {
  const groupId = crypto.randomUUID()
  const row: WorkspaceGroupRow = {
    projectSlug,
    groupId,
    name: groupName(name),
    pinned: workspaceId === null,
    createdAt: new Date(),
  }
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.insert(workspaceGroups).values(row)
    if (workspaceId === null) return
    const filed = await tx.update(workspaces).set({ groupId })
      .where(and(eq(workspaces.projectSlug, projectSlug), eq(workspaces.workspaceId, workspaceId)))
      .returning({ workspaceId: workspaces.workspaceId })
    if (filed.length === 0) throw unknownWorkspace(projectSlug, workspaceId)
  })
  notifyWorkspaceListChanged()
  return row
}

/** Rename a group. A blank name keeps the old one — a group is only ever
 *  identified by its name, so there is nothing to fall back to. */
export async function renameWorkspaceGroup(
  projectSlug: string,
  groupId: string,
  name: string,
): Promise<void> {
  const normalized = groupName(name)
  if (normalized === '') return
  const db = await getDb()
  await db.update(workspaceGroups).set({ name: normalized }).where(key(projectSlug, groupId))
  notifyWorkspaceListChanged()
}

/** Pin (or unpin) a group — whether it stays listed with no live workspace. */
export async function setWorkspaceGroupPinned(
  projectSlug: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaceGroups).set({ pinned }).where(key(projectSlug, groupId))
  notifyWorkspaceListChanged()
}

/**
 * Delete a group and return its workspaces to the default list — live and
 * stopped alike, and the queued and draft ones that would have been filed
 * there — in one transaction with the row's removal. Releasing them is
 * what makes the delete safe to offer without a confirmation: nothing is torn
 * down, and every workspace stays exactly where it can be found.
 */
export async function deleteWorkspaceGroup(
  projectSlug: string,
  groupId: string,
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({ groupId: null })
      .where(and(eq(workspaces.projectSlug, projectSlug), eq(workspaces.groupId, groupId)))
    // A launched entry is a record of what it launched into; left as it was.
    await tx.update(queuedWorkspaces).set({ groupId: null })
      .where(and(
        eq(queuedWorkspaces.projectSlug, projectSlug),
        eq(queuedWorkspaces.groupId, groupId),
        isNull(queuedWorkspaces.launchedWorkspaceId),
      ))
    await tx.update(draftWorkspaces).set({ groupId: null })
      .where(and(eq(draftWorkspaces.projectSlug, projectSlug), eq(draftWorkspaces.groupId, groupId)))
    await tx.delete(workspaceGroups).where(key(projectSlug, groupId))
  })
  notifyWorkspaceListChanged()
}

/** Every group of a project (or of all projects) — the snapshot's source. */
export async function listWorkspaceGroupRows(projectSlug?: string): Promise<WorkspaceGroupRow[]> {
  const db = await getDb()
  return projectSlug === undefined
    ? await db.select().from(workspaceGroups)
    : await db.select().from(workspaceGroups)
      .where(eq(workspaceGroups.projectSlug, projectSlug))
}

/**
 * File a workspace under a group, or (with `null`) return it to the default
 * list. The drag-and-drop write, and the only one a client can aim at a group
 * it no longer has: the sidebar acts on a snapshot, and the group may have
 * been deleted between the render and the drop. Both ends are checked, so a
 * move that lands nowhere says so instead of reporting a success that filed
 * nothing.
 */
export async function setWorkspaceGroup(
  projectSlug: string,
  workspaceId: string,
  groupId: string | null,
): Promise<void> {
  const db = await getDb()
  if (groupId !== null) {
    const rows = await db.select({ groupId: workspaceGroups.groupId })
      .from(workspaceGroups).where(key(projectSlug, groupId))
    if (rows.length === 0) {
      throw new ServerError('NOT_FOUND', `No such workspace group: ${groupId}`)
    }
  }
  const filed = await db.update(workspaces).set({ groupId })
    .where(and(eq(workspaces.projectSlug, projectSlug), eq(workspaces.workspaceId, workspaceId)))
    .returning({ workspaceId: workspaces.workspaceId })
  if (filed.length === 0) throw unknownWorkspace(projectSlug, workspaceId)
  notifyWorkspaceListChanged()
}

/**
 * Forget a project's groups. Like `deleteProjectWorkspaces`, this is the
 * project going away — a group never outlives the workspaces it files.
 */
export async function deleteProjectWorkspaceGroups(projectSlug: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaceGroups).where(eq(workspaceGroups.projectSlug, projectSlug))
}

/** Group names get the same trim/collapse/cap a workspace title does — they
 *  are the same kind of user-typed label in the same sidebar. */
function groupName(name: string): string {
  return normalizeTitle(name)
}

/** Every membership write is scoped to a project, so a workspace from another
 *  one is as unknown as a workspace that never existed. */
function unknownWorkspace(projectSlug: string, workspaceId: string): ServerError {
  return new ServerError('NOT_FOUND', `No such workspace in ${projectSlug}: ${workspaceId}`)
}
