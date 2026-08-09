import { publishDesiredWorkspaces } from '#herd-desired'
import { listLiveWorktreeRows, listStoppedWorktreeIds } from './worktree-store'

/**
 * Push what the server records as existing down to the herd, so its reaper
 * can tell a leaked runtime from a create that died (see `#herd-desired`).
 *
 * A reconcile step of its own, ordered before the reaper, because the reaper
 * must never act on a set older than the pass it is running in — a workspace
 * created since the last push would otherwise look like a runtime nothing
 * recorded.
 *
 * A read failure publishes nothing rather than an empty set: the reaper keeps
 * using the last set it was given, and if there has never been one it does
 * nothing at all.
 */
export async function pushDesiredWorkspaces(): Promise<void> {
  const [live, stopped] = await Promise.all([
    listLiveWorktreeRows(),
    listStoppedWorktreeIds(),
  ])
  publishDesiredWorkspaces({ live, stopped: [...stopped] })
}
