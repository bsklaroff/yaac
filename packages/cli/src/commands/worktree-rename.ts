import { api } from '#commands/api'

/**
 * `yaac worktree rename <worktree-id> <title>` — set the label the sidebar
 * and the listings show in place of a worktree's id.
 *
 * Resolves in any state, like the route it calls: renaming a stopped or
 * still-waiting worktree is fine, because a title lives on the host rather
 * than in the container.
 */
export async function worktreeRename(worktreeId: string, title: string): Promise<void> {
  await api.worktree[':id'].title.$post({
    param: { id: worktreeId },
    json: { title },
  })
  console.log(`Renamed ${worktreeId.slice(0, 8)} to "${title.trim()}".`)
}
