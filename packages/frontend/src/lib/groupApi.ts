import { api } from './api'

/**
 * The sidebar's worktree groups. Every call is addressed by (project, …)
 * rather than through a container lookup, because a group outlives the
 * containers of its members: a stopped worktree can be dragged out of a group,
 * and a pinned group can hold nothing but ghost rows.
 *
 * None of these are optimistic. Group state rides the snapshot, so the server
 * push is what re-renders the sidebar — the same way the row's rename does.
 */

/** Create a group around a worktree; the founding member goes in with it. */
export async function createWorktreeGroup(
  projectSlug: string,
  worktreeId: string,
  name: string,
): Promise<{ groupId: string }> {
  return await api.worktree.group.create.$post({ json: { projectSlug, worktreeId, name } })
}

export async function renameWorktreeGroup(
  projectSlug: string,
  groupId: string,
  name: string,
): Promise<void> {
  await api.worktree.group.rename.$post({ json: { projectSlug, groupId, name } })
}

/** Pin (or unpin) a group — whether it stays listed once its last live
 *  worktree stops. */
export async function setWorktreeGroupPinned(
  projectSlug: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  await api.worktree.group['set-pinned'].$post({ json: { projectSlug, groupId, pinned } })
}

/** Delete a group. Its worktrees are not touched — they return to the default
 *  list, which is why this needs no confirmation. */
export async function deleteWorktreeGroup(
  projectSlug: string,
  groupId: string,
): Promise<void> {
  await api.worktree.group.delete.$post({ json: { projectSlug, groupId } })
}

/** File a worktree under a group, or (with `null`) return it to the default
 *  list. The drop half of sidebar drag-and-drop. */
export async function setWorktreeGroup(
  projectSlug: string,
  worktreeId: string,
  groupId: string | null,
): Promise<void> {
  await api.worktree['set-group'].$post({ json: { projectSlug, worktreeId, groupId } })
}
