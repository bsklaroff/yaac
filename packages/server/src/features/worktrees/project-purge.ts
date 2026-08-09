import fs from 'node:fs/promises'
import { type PodInfo, listWorktreePods } from '#platform/k8s'
import { removeProjectRegistry } from '#features/cluster'
import { projectRoots } from '@yaac/shared/project-paths'
import { cleanupWorktreeDetached } from './cleanup'

/**
 * Delete every byte a project has on the substrate: its live worktrees, its
 * per-project push registry, and both of its storage-tier roots.
 *
 * The herd's half of `project remove`. The rows that say the project exists
 * are the server's and it deletes them itself (see `project-teardown.ts`);
 * this half knows only about bytes, which is why it is best-effort throughout
 * — a cluster that cannot be reached must not stop the directories from going
 * away, and the server-start orphan GCs sweep whatever a failure leaves.
 */
export async function purgeProjectBytes(slug: string): Promise<void> {
  let pods: PodInfo[] = []
  try {
    pods = await listWorktreePods(slug)
  } catch {
    // cluster unavailable — skip worktree cleanup, still nuke the dirs.
  }

  for (const p of pods) {
    try {
      await cleanupWorktreeDetached({
        jobName: p.jobName,
        projectSlug: slug,
        worktreeId: p.worktreeId,
      })
    } catch {
      // best-effort cleanup — continue with the next worktree
    }
  }

  // Per-project push registry (virtualCluster worktrees). Best-effort —
  // the server-start orphan GC sweeps anything this misses, since the
  // project dir is gone after the rm below.
  try {
    await removeProjectRegistry(slug)
  } catch {
    // cluster unavailable — the orphan GC will catch it
  }

  // Both tier roots: the project's node-local tree (the pnpm store and
  // opencode data) is not under `dir` once the tiers are separate volumes,
  // and nothing else would ever reclaim it — the orphan GC sweeps worktrees
  // within a project, not a project whose record is gone. One rm today.
  for (const root of projectRoots(slug)) {
    await fs.rm(root, { recursive: true, force: true })
  }
}
