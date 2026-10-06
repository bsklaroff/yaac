import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { draftWorkspaces, queuedWorkspaces, workspaceGroups, workspaces } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { ServerError } from '@yaac/shared/errors'
import { normalizeTitle } from '@yaac/shared/titles'

/**
 * Named sidebar groups for a project's workspaces. Nothing observes a group,
 * so writes here notify the snapshot hub directly rather than going through
 * `applyWorkspaceEvent`. Membership is `workspaces.groupId`; this table holds
 * the name and pinned flag.
 *
 * The schema has no foreign keys, so this module keeps integrity: a move
 * checks the target group exists, a delete ungroups its members, and project
 * teardown removes the rows. Empty groups are not deleted; the sidebar hides
 * a group with no live workspace, so restarting a stopped member brings it
 * back.
 */

/** A group row as the display paths consume it. */
export interface WorkspaceGroupRow {
  projectId: string
  groupId: string
  name: string
  pinned: boolean
  createdAt: Date
}

const key = (projectId: string, groupId: string) =>
  and(eq(workspaceGroups.projectId, projectId), eq(workspaceGroups.groupId, groupId))

/**
 * Create a group around a founding workspace, or empty (`null`).
 *
 * With a founding workspace, the insert and the membership update share a
 * transaction; an unknown workspace (or one in another project) throws and
 * rolls back, so no unpinned empty group is left behind.
 *
 * An empty group (`yaac group create`, or `--group` before the workspace
 * exists) starts pinned so the sidebar shows it.
 *
 * A founded group is unpinned and can later become empty, which the sidebar
 * hides. It is still listed by `listWorkspaceGroups`, so `yaac group list`
 * and `yaac group delete` can reach it, and project teardown removes it.
 */
export async function createWorkspaceGroup(
  projectId: string,
  name: string,
  workspaceId: string | null,
): Promise<WorkspaceGroupRow> {
  const groupId = crypto.randomUUID()
  const row: WorkspaceGroupRow = {
    projectId,
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
      .where(and(eq(workspaces.projectId, projectId), eq(workspaces.workspaceId, workspaceId)))
      .returning({ workspaceId: workspaces.workspaceId })
    if (filed.length === 0) throw unknownWorkspace(projectId, workspaceId)
  })
  notifyWorkspaceListChanged()
  return row
}

/** Rename a group. A blank name is ignored, since a group has only its name
 *  to show. */
export async function renameWorkspaceGroup(
  projectId: string,
  groupId: string,
  name: string,
): Promise<void> {
  const normalized = groupName(name)
  if (normalized === '') return
  const db = await getDb()
  await db.update(workspaceGroups).set({ name: normalized }).where(key(projectId, groupId))
  notifyWorkspaceListChanged()
}

/** Pin or unpin a group; a pinned group stays shown with no live workspace. */
export async function setWorkspaceGroupPinned(
  projectId: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  const db = await getDb()
  await db.update(workspaceGroups).set({ pinned }).where(key(projectId, groupId))
  notifyWorkspaceListChanged()
}

/**
 * Delete a group and, in the same transaction, ungroup its live, stopped,
 * queued and draft workspaces. Nothing is torn down, so the delete needs no
 * confirmation.
 */
export async function deleteWorkspaceGroup(
  projectId: string,
  groupId: string,
): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(workspaces).set({ groupId: null })
      .where(and(eq(workspaces.projectId, projectId), eq(workspaces.groupId, groupId)))
    // Launched entries record where they launched, so leave them.
    await tx.update(queuedWorkspaces).set({ groupId: null })
      .where(and(
        eq(queuedWorkspaces.projectId, projectId),
        eq(queuedWorkspaces.groupId, groupId),
        isNull(queuedWorkspaces.launchedWorkspaceId),
      ))
    await tx.update(draftWorkspaces).set({ groupId: null })
      .where(and(eq(draftWorkspaces.projectId, projectId), eq(draftWorkspaces.groupId, groupId)))
    await tx.delete(workspaceGroups).where(key(projectId, groupId))
  })
  notifyWorkspaceListChanged()
}

/** Every group of a project, or of all projects (the snapshot's source). */
export async function listWorkspaceGroupRows(projectId?: string): Promise<WorkspaceGroupRow[]> {
  const db = await getDb()
  return projectId === undefined
    ? await db.select().from(workspaceGroups)
    : await db.select().from(workspaceGroups)
      .where(eq(workspaceGroups.projectId, projectId))
}

/**
 * File a workspace under a group, or ungroup it (`null`). Used by sidebar
 * drag-and-drop, where the group may have been deleted since the snapshot
 * rendered, so both the group and the workspace are checked and a miss
 * throws NOT_FOUND.
 */
export async function setWorkspaceGroup(
  projectId: string,
  workspaceId: string,
  groupId: string | null,
): Promise<void> {
  const db = await getDb()
  if (groupId !== null) {
    const rows = await db.select({ groupId: workspaceGroups.groupId })
      .from(workspaceGroups).where(key(projectId, groupId))
    if (rows.length === 0) {
      throw new ServerError('NOT_FOUND', `No such workspace group: ${groupId}`)
    }
  }
  const filed = await db.update(workspaces).set({ groupId })
    .where(and(eq(workspaces.projectId, projectId), eq(workspaces.workspaceId, workspaceId)))
    .returning({ workspaceId: workspaces.workspaceId })
  if (filed.length === 0) throw unknownWorkspace(projectId, workspaceId)
  notifyWorkspaceListChanged()
}

/** Delete a project's groups, on project removal. */
export async function deleteProjectWorkspaceGroups(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(workspaceGroups).where(eq(workspaceGroups.projectId, projectId))
}

/** Group names are normalized like workspace titles. */
function groupName(name: string): string {
  return normalizeTitle(name)
}

/** Membership writes are project-scoped, so a workspace in another project
 *  is reported as unknown. */
function unknownWorkspace(projectId: string, workspaceId: string): ServerError {
  return new ServerError('NOT_FOUND', `No such workspace in ${projectId}: ${workspaceId}`)
}
