import { getWorkspaceRow } from '#db'

/**
 * The branch a workspace forked from, from its row, or null (the diff script
 * then falls back to `@{upstream}`). The row is used because the workspace
 * cannot change it; the checkout's upstream moves to the pushed branch after
 * `git push -u`, which would show no changes.
 */
export async function workspaceForkBranch(projectSlug: string, workspaceId: string): Promise<string | null> {
  const row = await getWorkspaceRow(projectSlug, workspaceId).catch(() => undefined)
  return row?.baseBranch ?? null
}
