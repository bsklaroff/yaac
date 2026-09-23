import fs from 'node:fs/promises'
import { worktreeDriver } from '#drivers/driver'
import type { RuntimeHandle } from '#drivers/contract'
import { projectDir } from '@yaac/shared/project-paths'
import { cleanupWorktreeDetached } from './cleanup'

/**
 * Delete every byte a project has on the substrate: its live worktrees, its
 * per-project push registry, its node-local tree on every node, and its
 * global tree.
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
  // the push registry a nestedContainers worktree pushes to, and the
  // project's NODE-LOCAL tree on every node (the pnpm store, the opencode
  // working copies, the image stores). A separate pass from the rm below
  // because those bytes are not under the global tree: they live where
  // the worktrees ran, some of them root-owned, and only the runtime can
  // reach them.
  //
  // Best-effort, like the rest of this function: the runtime's own sweeps
  // collect whatever a failure leaves, and an unreachable runtime must not
  // stop the global tree from going away.
  try {
    await worktreeDriver().destroyProjectSubstrate(slug)
  } catch {
    // runtime unavailable — the node-local sweep will catch it
  }

  await fs.rm(projectDir(slug), { recursive: true, force: true })
}
