import { getWorkspaceRow } from '#db'

/**
 * The branch a workspace forked from, or null when its row records none — the
 * pod script then falls back on its own `@{upstream}`, inside the workspace
 * where that question belongs.
 *
 * The row is the authority because it is OURS: it is stamped when the create
 * resolves the fork branch (and again by the claim-time re-branch prep), and
 * nothing in the workspace can touch it. The checkout's own upstream is not
 * a second source: one `git push -u origin HEAD:<pr-branch>` repoints it at
 * the branch just pushed, whose fork point is HEAD, which would report a
 * workspace with a pushed PR as having no changes at all.
 */
export async function workspaceForkBranch(projectSlug: string, workspaceId: string): Promise<string | null> {
  const row = await getWorkspaceRow(projectSlug, workspaceId).catch(() => undefined)
  return row?.baseBranch ?? null
}
