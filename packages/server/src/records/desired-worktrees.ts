import { listLiveWorktreeRows, listStoppedWorktreeIds } from './worktree-store'

/**
 * What the server records as existing — what the stale reaper judges an
 * absence against. A runtime with no record is a leak to clean up; a record
 * with no runtime is a create that died; and the substrate cannot tell one
 * from the other, which is why the reaper reads this rather than only
 * looking at pods.
 *
 * Read fresh at the top of the reaper's pass, so absence is only ever
 * judged against a set from the same pass. A read failure must stand the
 * sweeps down (say nothing, reap nothing), never read as an empty set — an
 * empty set is a legitimate answer only when the rows really say so.
 */
export interface DesiredWorktrees {
  live: DesiredWorktree[]
  /** `<projectSlug>/<worktreeId>` of worktrees already recorded as stopped —
   *  what tells a teardown yaac issued from one that happened to it. */
  stopped: string[]
}

export interface DesiredWorktree {
  projectSlug: string
  worktreeId: string
  /** Whether its agent ever got going. Separates an interrupted create from a
   *  worktree with real history whose runtime was removed out from under it,
   *  which is the difference between `never-started` and `orphaned`. */
  ran: boolean
}

export async function desiredWorktrees(): Promise<DesiredWorktrees> {
  const [live, stopped] = await Promise.all([
    listLiveWorktreeRows(),
    listStoppedWorktreeIds(),
  ])
  return { live, stopped: [...stopped] }
}
