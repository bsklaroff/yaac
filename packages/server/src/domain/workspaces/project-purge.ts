import fs from 'node:fs/promises'
import { workspaceDriver } from '#drivers/driver'
import type { ProjectRef, RuntimeHandle } from '#drivers/contract'
import { projectDir } from '@yaac/shared/project-paths'
import { cleanupWorkspaceDetached } from './cleanup'

/**
 * Delete everything a project has on disk and on the substrate: live
 * workspaces, driver-held state (push registry, node-local trees) and the
 * global tree. The bytes half of `project remove` (rows are deleted in
 * `project-teardown.ts`). Best-effort throughout; the driver's id-keyed
 * sweeps collect whatever a failure leaves.
 */
export async function purgeProjectBytes(project: ProjectRef): Promise<void> {
  const { slug } = project
  let pods: RuntimeHandle[] = []
  try {
    pods = await workspaceDriver().list(slug)
  } catch {
    // Runtime unavailable: still remove the dirs.
  }

  for (const p of pods) {
    try {
      await cleanupWorkspaceDetached({
        jobName: p.jobName,
        projectSlug: slug,
        workspaceId: p.workspaceId,
      })
    } catch {
      // Best-effort; continue with the next workspace.
    }
  }

  // Node-local and driver-held bytes live where the workspaces ran, so only
  // the driver can reach them.
  try {
    await workspaceDriver().destroyProjectSubstrate(project)
  } catch {
    // The id-keyed sweeps will collect it.
  }

  // Safe after the teardowns above: `rm` does not follow links, and no pod
  // is left to swap one in mid-walk.
  await fs.rm(projectDir(slug), { recursive: true, force: true })
}
