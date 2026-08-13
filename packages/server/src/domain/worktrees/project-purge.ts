import fs from 'node:fs/promises'
import { worktreeDriver } from '#drivers/driver'
import type { RuntimeHandle } from '#drivers/contract'
import { projectRoots } from '@yaac/shared/project-paths'
import { cleanupWorktreeDetached } from './cleanup'

/**
 * Delete every byte a project has on the substrate: its live worktrees, its
 * per-project push registry, its node-local image stores, and both of its
 * storage-tier roots.
 *
 * The bytes half of `project remove`. The rows that say the project exists
 * are the server's and it deletes them itself (see `project-teardown.ts`);
 * this half knows only about bytes, which is why it is best-effort throughout
 * — a cluster that cannot be reached must not stop the directories from going
 * away, and the server-start orphan GCs sweep whatever a failure leaves.
 */
export async function purgeProjectBytes(slug: string): Promise<void> {
  let pods: RuntimeHandle[] = []
  try {
    pods = await worktreeDriver().list(slug)
  } catch {
    // cluster unavailable — skip worktree cleanup, still nuke the dirs.
  }

  for (const p of pods) {
    try {
      await cleanupWorktreeDetached({
        jobName: p.jobName,
        projectSlug: slug,
        worktreeId: p.workspaceId,
      })
    } catch {
      // best-effort cleanup — continue with the next worktree
    }
  }

  // Everything the runtime holds for the project beyond its worktrees —
  // the push registry a virtualCluster worktree pushes to, and the
  // node-local image stores. A separate pass from the rm below because
  // those bytes live outside the project tree, ROOT-owned, precisely
  // because the server's own uid could not remove them.
  //
  // Best-effort, like the rest of this function: the server-start orphan
  // GCs sweep whatever a failure leaves, and an unreachable runtime must
  // not stop the directories from going away.
  try {
    await worktreeDriver().destroyProjectSubstrate(slug)
  } catch {
    // runtime unavailable — the orphan GCs will catch it
  }

  // Both tier roots: the project's node-local tree (the pnpm store and
  // opencode data) is not under `dir` once the tiers are separate volumes,
  // and nothing else would ever reclaim it — the orphan GC sweeps worktrees
  // within a project, not a project whose record is gone. One rm today.
  for (const root of projectRoots(slug)) {
    await fs.rm(root, { recursive: true, force: true })
  }
}
