import { api } from '#commands/api'

/**
 * `yaac worktree delete <id>` — discard a stopped worktree for good: its
 * checkout, its diff, and the record that listed it. The counterpart to
 * `worktree stop`, which keeps every one of those so a `restart` can
 * re-attach; nothing else reclaims a worktree's disk short of removing the
 * whole project.
 *
 * Refuses a worktree that is still running rather than stopping it on the
 * way, so "delete" never means "and take down what was working in it".
 */
export async function worktreeDelete(idOrName: string): Promise<void> {
  const info = await api.worktree.delete.$post({ json: { worktreeId: idOrName } })
  console.log(`Worktree ${info.worktreeId} deleted; its checkout is gone.`)
}
