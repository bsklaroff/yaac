import { getWorkspaceRow } from '#db'

/**
 * The branch a workspace is based on, from its row, or null (the diff script
 * then falls back to `@{upstream}`). The row is used because the checkout's
 * upstream moves to the pushed branch after `git push -u`, which would show
 * no changes.
 */
export async function workspaceForkBranch(projectId: string, workspaceId: string): Promise<string | null> {
  const row = await getWorkspaceRow(projectId, workspaceId).catch(() => undefined)
  return row?.baseBranch ?? null
}
