/**
 * The `ready-trees` step (docs/generic-workspace-pods.md "Trees"): which
 * working trees the nodes keep built ahead of time, so a start takes one
 * by a rename instead of waiting for a build. The rule is the pool's: one
 * tree for each repo checked out in a workspace running now, or in one that
 * stopped less than a day ago, in any project, at the commit the main clone
 * has for the repo's default branch. Each pass reads the commits fresh, so
 * a fetch that moves a branch has the new tree built and the old removed
 * on the next pass.
 */
import { workspaceDriver } from '#drivers/driver'
import { listRecentWorkspaces, listWorkspaceReposFor } from '#db'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { repoDir } from '@yaac/shared/project-paths'
import { serverLog } from '#lib/log'

/** How long a stopped workspace's repos stay ready. */
const RECENT_MS = 24 * 60 * 60_000

/** The trees to keep: each repo once, at its default branch's tip. A repo
 *  whose tip cannot be read is left out. */
export async function readyTrees(repoIds: string[]): Promise<Array<{ repoId: string; commit: string }>> {
  const trees = await Promise.all([...new Set(repoIds)].map(async (repoId) => {
    try {
      const dir = repoDir(repoId)
      return { repoId, commit: await resolveRemoteRef(dir, await getDefaultBranch(dir)) }
    } catch (err) {
      serverLog(`[ready-trees] reading ${repoId}'s default branch failed: ${String(err)}`)
      return null
    }
  }))
  return trees.filter((t) => t !== null)
}

export async function reconcileReadyTrees(): Promise<void> {
  const recent = await listRecentWorkspaces(new Date(Date.now() - RECENT_MS))
  const held = await listWorkspaceReposFor(recent.map((w) => w.workspaceId))
  const repoIds = [...held.values()].flat().map((r) => r.repoId)
  await workspaceDriver().keepReadyTrees(await readyTrees(repoIds))
}
