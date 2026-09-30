import { api } from './api'

/**
 * The sidebar's workspace groups. Every call is addressed by (project, …)
 * rather than through a container lookup, because a group outlives the
 * containers of its members: a stopped workspace can be dragged out of a group,
 * and a pinned group can hold nothing but ghost rows.
 *
 * None of these are optimistic. Group state rides the snapshot, so the server
 * push is what re-renders the sidebar — the same way the row's rename does.
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

/** Pin (or unpin) a group — whether it stays listed once its last live
 *  workspace stops. */
export async function setWorkspaceGroupPinned(
  projectSlug: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  await api.workspace.group['set-pinned'].$post({ json: { projectSlug, groupId, pinned } })
}

/** Delete a group. Its workspaces are not touched — they return to the default
 *  list, which is why this needs no confirmation. */
export async function deleteWorkspaceGroup(
  projectSlug: string,
  groupId: string,
): Promise<void> {
  await api.workspace.group.delete.$post({ json: { projectSlug, groupId } })
}

/** File a workspace under a group, or (with `null`) return it to the default
 *  list. The drop half of sidebar drag-and-drop. */
export async function setWorkspaceGroup(
  projectSlug: string,
  workspaceId: string,
  groupId: string | null,
): Promise<void> {
  await api.workspace['set-group'].$post({ json: { projectSlug, workspaceId, groupId } })
}
