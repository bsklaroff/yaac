import fs from 'node:fs/promises'
import { worktreeRuntime } from '#runtime/driver'
import type { RuntimeHandle } from '#runtime/contract'
import { removeProjectRegistry } from '#runtime/k8s/cluster'
import { removeNodeImageStore } from '#runtime/k8s/images'
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
    pods = await worktreeRuntime().list(slug)
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

  // Per-project push registry (virtualCluster worktrees). Best-effort —
  // the server-start orphan GC sweeps anything this misses, since the
  // project dir is gone after the rm below.
  try {
    await removeProjectRegistry(slug)
  } catch {
    // cluster unavailable — the orphan GC will catch it
  }

  // The node-local image store on every node. A separate pass from the rm
  // below because its bytes are ROOT-owned (a node-side pod wrote them) and
  // live outside the project tree for exactly that reason — the server's
  // own uid could not remove them (see `imageStoreDir`).
  try {
    await removeNodeImageStore(slug)
  } catch {
    // cluster unavailable — a stale store is a cache nothing will mount
  }

  // Both tier roots: the project's node-local tree (the pnpm store and
  // opencode data) is not under `dir` once the tiers are separate volumes,
  // and nothing else would ever reclaim it — the orphan GC sweeps worktrees
  // within a project, not a project whose record is gone. One rm today.
  for (const root of projectRoots(slug)) {
    await fs.rm(root, { recursive: true, force: true })
  }
}
