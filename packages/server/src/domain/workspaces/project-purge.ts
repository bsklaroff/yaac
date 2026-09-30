import fs from 'node:fs/promises'
import { workspaceDriver } from '#drivers/driver'
import type { ProjectRef, RuntimeHandle } from '#drivers/contract'
import { projectDir } from '@yaac/shared/project-paths'
import { cleanupWorkspaceDetached } from './cleanup'

/**
 * Delete every byte a project has on the substrate: its live workspaces, its
 * per-project push registry, its node-local tree on every node, and its
 * global tree.
 *
 * The bytes half of `project remove`. The rows that say the project exists
 * are the server's and it deletes them itself (see `project-teardown.ts`);
 * this half knows only about bytes, which is why it is best-effort throughout
 * — a cluster that cannot be reached must not stop the directories from going
 * away, and the runtime's orphan GCs, keyed on the project id, sweep
 * whatever a failure leaves.
 */
export async function purgeProjectBytes(project: ProjectRef): Promise<void> {
  const { slug } = project
  let pods: RuntimeHandle[] = []
  try {
    pods = await workspaceDriver().list(slug)
  } catch {
    // cluster unavailable — skip workspace cleanup, still nuke the dirs.
  }

  for (const p of pods) {
    try {
      await cleanupWorkspaceDetached({
        jobName: p.jobName,
        projectSlug: slug,
        workspaceId: p.workspaceId,
      })
    } catch {
      // best-effort cleanup — continue with the next workspace
    }
  }

  // Everything the runtime holds for the project beyond its workspaces —
  // the push registry a nestedContainers workspace pushes to, and the
  // project's NODE-LOCAL tree on every node (the pnpm store, the opencode
  // working copies, the image stores). A separate pass from the rm below
  // because those bytes are not under the global tree: they live where
  // the workspaces ran, some of them root-owned, and only the runtime can
  // reach them.
  //
  // Best-effort, like the rest of this function: the runtime's own sweeps
  // collect whatever a failure leaves, and an unreachable runtime must not
  // stop the global tree from going away.
  try {
    await workspaceDriver().destroyProjectSubstrate(project)
  } catch {
    // runtime unavailable — the id-keyed sweeps will catch it
  }

  // A plain recursive `rm` over trees the sandboxes wrote, sound because it
  // runs after every workspace above was torn down: Node's `rm` follows no
  // link it meets, and with no pod left to swap a directory for one
  // mid-walk, a walk by path cannot be steered out.
  await fs.rm(projectDir(slug), { recursive: true, force: true })
}
