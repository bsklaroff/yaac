import fs from 'node:fs/promises'
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeHandle } from '#drivers/contract'
import { hostedRepoDir, projectDir } from '@yaac/shared/project-paths'
import { cleanupWorkspaceDetached } from './cleanup'
import {
  deleteProjectAgentSessions,
  deleteProjectDraftWorkspaces,
  deleteProjectEnvVars,
  deleteProjectQueuedWorkspaces,
  deleteProjectRow,
  deleteProjectWorkspaceGroups,
  deleteProjectWorkspaces,
  getProjectRow,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'
import { authorizeProject, type Actor } from '#domain/access'

/**
 * Remove a project: its workspaces and bytes (`purgeProjectBytes`), then its
 * rows. Throws `NOT_FOUND` if it does not exist. The project row goes last,
 * so a failed removal leaves a project that can still be listed and removed
 * again. Lives here rather than in #domain/projects to avoid an import
 * cycle.
 */
export async function removeProject(principal: Actor, projectId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)

  await purgeProjectBytes(projectId)
  // The macOS Keychain item containerless claude keys on the tool home path.
  // No-op elsewhere.
  dropProjectClaudeKeychainItem(projectId)

  await deleteProjectWorkspaces(projectId)
  await deleteProjectAgentSessions(projectId)
  await deleteProjectWorkspaceGroups(projectId)
  await deleteProjectQueuedWorkspaces(projectId)
  await deleteProjectDraftWorkspaces(projectId)
  await deleteProjectEnvVars(projectId)
  await deleteProjectRow(projectId)
}

/**
 * Delete everything a project has on disk and on the substrate: live
 * workspaces, driver-held state (push registry, node-local trees), the
 * global tree, and a hosted project's remote. Best-effort throughout; the
 * driver's id-keyed sweeps collect whatever a failure leaves.
 */
async function purgeProjectBytes(projectId: string): Promise<void> {
  let pods: RuntimeHandle[] = []
  try {
    pods = await workspaceDriver().list(projectId)
  } catch {
    // Runtime unavailable: still remove the dirs.
  }

  for (const p of pods) {
    try {
      await cleanupWorkspaceDetached({
        jobName: p.jobName,
        projectId,
        workspaceId: p.workspaceId,
      })
    } catch {
      // Best-effort; continue with the next workspace.
    }
  }

  // Node-local and driver-held bytes live where the workspaces ran, so only
  // the driver can reach them.
  try {
    await workspaceDriver().destroyProjectSubstrate(projectId)
  } catch {
    // The id-keyed sweeps will collect it.
  }

  // Safe after the teardowns above: `rm` does not follow links, and no pod
  // is left to swap one in mid-walk.
  await fs.rm(projectDir(projectId), { recursive: true, force: true })
  // A hosted project's remote is its only authoritative copy; the remove
  // confirmation says so.
  await fs.rm(hostedRepoDir(projectId), { recursive: true, force: true })
}
