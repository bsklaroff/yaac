import { workspaceDriver } from '#drivers/driver'
import type { RuntimeHandle } from '#drivers/contract'
import { getProjectsDir } from '@yaac/shared/paths'
import { cleanupWorkspaceDetached, removeEntries } from './cleanup'
import {
  deleteProjectConversations,
  deleteProjectDraftWorkspaces,
  deleteProjectEnvVars,
  deleteProjectQueuedWorkspaces,
  deleteProjectRoutines,
  deleteProjectRow,
  deleteProjectRunSecrets,
  deleteProjectWorkflows,
  deleteProjectSiteRows,
  deleteProjectVolumeRows,
  deleteProjectWorkspaceGroups,
  deleteProjectWorkspaces,
  getProjectRow,
  listProjectVolumes,
} from '#db'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'
import { authorizeProject, type Actor } from '#domain/access'

/**
 * Remove a project: its workspaces and bytes (`purgeProjectBytes`), then its
 * rows. Throws `NOT_FOUND` if it does not exist. The project row goes last,
 * so a failed removal leaves a project that can still be listed and removed
 * again. Its repos stay among their owners', unlinked from it
 * (docs/project-repos.md). Lives here rather than in #domain/projects to
 * avoid an import cycle.
 */
export async function removeProject(principal: Actor, projectId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  await deleteProject(projectId)
}

async function deleteProject(projectId: string): Promise<void> {
  // First, so the sites step neither replaces a release the purge stops nor
  // advances a deploy into the project (docs/public-sites.md).
  await deleteProjectSiteRows(projectId)
  await purgeProjectBytes(projectId)
  // The macOS Keychain item containerless claude keys on the tool home path.
  // No-op elsewhere.
  dropProjectClaudeKeychainItem(projectId)

  await deleteProjectWorkspaces(projectId)
  await deleteProjectConversations(projectId)
  await deleteProjectWorkspaceGroups(projectId)
  // Entries first: a run's entry references its routine.
  await deleteProjectQueuedWorkspaces(projectId)
  await deleteProjectRoutines(projectId)
  await deleteProjectDraftWorkspaces(projectId)
  await deleteProjectEnvVars(projectId)
  await deleteProjectRunSecrets(projectId)
  await deleteProjectVolumeRows(projectId)
  await deleteProjectRow(projectId)
  // Last, as everything above may name them.
  await deleteProjectWorkflows(projectId)
}

/**
 * Delete everything a project has on disk and on the substrate: live
 * workspaces, volumes, driver-held state (push registry, node-local trees)
 * and the global tree. Best-effort throughout; the driver's id-keyed sweeps
 * collect whatever a failure leaves.
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

  // A volume outlives every workspace, but not its project. A pod still
  // shutting down may keep one mounted; `collectDeletedVolumes` removes what
  // this leaves, from the tombstones the rows' delete writes.
  if (workspaceDriver().kind === 'k8s') {
    for (const v of await listProjectVolumes(projectId).catch(() => [])) {
      await workspaceDriver().deleteVolume(v.id)
        .catch((err: unknown) => serverLog(`[server] deleting volume ${v.name} of project ${projectId}: ${String(err)}`))
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
  await removeEntries(getProjectsDir(), [projectId])
}
