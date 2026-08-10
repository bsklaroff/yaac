import { publishDesiredWorkspaces } from '#herd-desired'
import { listLiveWorktreeRows, listStoppedWorktreeIds } from './worktree-store'

/**
 * Push what the server records as existing down to the herd, so its reaper
 * can tell a leaked runtime from a create that died.
 *
 * A reconcile step of its own, ordered before the reaper, because the reaper
 * must never act on a set older than the pass it is running in — a workspace
 * created since the last push would otherwise look like a runtime nothing
 * recorded.
 *
 * A read failure publishes nothing rather than an empty set: the reaper keeps
 * using the last set it was given, and if there has never been one it does
 * nothing at all.
 *
 * `provisioning` rides along rather than being looked up on the other side:
 * it is the in-flight set out of the server's own registry, and a herd never
 * reads one. The caller passes only creates still in flight — a FAILED one is
 * not still running (its row lingers until dismissed, and its own rollback
 * tore down whatever it left), so it must shield nothing from a sweep.
 */
export async function pushDesiredWorkspaces(provisioning: string[]): Promise<void> {
  const [live, stopped] = await Promise.all([
    listLiveWorktreeRows(),
    listStoppedWorktreeIds(),
  ])
  publishDesiredWorkspaces({ live, stopped: [...stopped], provisioning })
}
