import { api } from './api'

/**
 * The sidebar's workspace groups. Calls are addressed by project rather than
 * by a running workspace, because a group outlives its members: a stopped
 * workspace can be dragged out of a group, and a pinned group may hold only
 * stopped rows.
 *
 * None of these are optimistic: group state arrives in the snapshot, so the
 * server's push re-renders the sidebar.
 */

/** Create a group around a workspace; the founding member goes in with it. */
export async function createWorkspaceGroup(
  projectSlug: string,
  workspaceId: string,
  name: string,
): Promise<{ groupId: string }> {
  return await api.workspace.group.create.$post({ json: { projectSlug, workspaceId, name } })
}

export async function renameWorkspaceGroup(
  projectSlug: string,
  groupId: string,
  name: string,
): Promise<void> {
  await api.workspace.group.rename.$post({ json: { projectSlug, groupId, name } })
}

/** A pinned group stays listed after its last live workspace stops. */
export async function setWorkspaceGroupPinned(
  projectSlug: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  await api.workspace.group['set-pinned'].$post({ json: { projectSlug, groupId, pinned } })
}

/** Delete a group. Its workspaces return to the default list, so this needs
 *  no confirmation. */
export async function deleteWorkspaceGroup(
  projectSlug: string,
  groupId: string,
): Promise<void> {
  await api.workspace.group.delete.$post({ json: { projectSlug, groupId } })
}

/** Move a workspace into a group, or (with `null`) back to the default list.
 *  Called on a sidebar drag-and-drop. */
export async function setWorkspaceGroup(
  projectSlug: string,
  workspaceId: string,
  groupId: string | null,
): Promise<void> {
  await api.workspace['set-group'].$post({ json: { projectSlug, workspaceId, groupId } })
}
