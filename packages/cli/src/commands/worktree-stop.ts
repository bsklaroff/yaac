import { api } from '#commands/api'

/**
 * `yaac worktree stop <id>` — tear down the container and keep the git
 * worktree. The checkout, its branch, and its diff all survive; a later
 * `yaac worktree restart` brings the agents back.
 */
export async function worktreeStop(idOrName: string): Promise<void> {
  const info = await api.worktree.stop.$post({ json: { worktreeId: idOrName } })
  console.log(`Worktree ${info.worktreeId} stopped; its checkout is kept.`)
}
