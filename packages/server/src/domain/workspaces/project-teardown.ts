import fs from 'node:fs/promises'
import { workspaceDriver } from '#drivers/driver'
import type { RuntimeHandle, RuntimeSnapshot } from '#drivers/contract'
import { hostedRepoDir } from '@yaac/shared/project-paths'
import { getProjectsDir } from '@yaac/shared/paths'
import { cleanupWorkspaceDetached, removeEntries } from './cleanup'
import {
  deleteProjectAgentSessions,
  deleteProjectDraftWorkspaces,
  deleteProjectEnvVars,
  deleteProjectQueuedWorkspaces,
  deleteProjectRoutines,
  deleteProjectRow,
  deleteProjectWorkspaceGroups,
  deleteProjectWorkspaces,
  getProjectRow,
  listProjectRows,
  setProjectShareRevoked,
  type ProjectRow,
} from '#db'
import { harvestToolCredentials } from '#domain/auth'
import { serverLog } from '#lib/log'
import { listProvisioning, stopProvisioning } from './provisioning'
import { ServerError } from '@yaac/shared/errors'
import { dropProjectClaudeKeychainItem } from '@yaac/shared/tool-auth'
import { authorizeProject, type Actor } from '#domain/access'

/**
 * Remove a project: its workspaces and bytes (`purgeProjectBytes`), then its
 * rows. Throws `NOT_FOUND` if it does not exist. The project row goes last,
 * so a failed removal leaves a project that can still be listed and removed
 * again. A project's shares go first, since its repository goes with it.
 * Lives here rather than in #domain/projects to avoid an import cycle.
 */
export async function removeProject(principal: Actor, projectId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  for (const share of (await listProjectRows()).filter((r) => r.sharedFrom === projectId)) {
    await deleteProject(share.id)
  }
  await deleteProject(projectId)
}

/**
 * Remove `userId`'s share of a project (docs/hosted-projects.md "Sharing"):
 * the share becomes read-only to its owner too, and its running workspaces
 * stop. Its rows, checkouts and sessions stay, for everyone to read. Only
 * the project's owner removes a share. A workspace that cannot be stopped
 * now is refused as RUNTIME_UNAVAILABLE, with the share already removed;
 * `reconcileRevokedShares` stops it later.
 */
export async function unshareProject(principal: Actor, projectId: string, userId: string): Promise<void> {
  if (!await getProjectRow(projectId)) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  await authorizeProject(principal, projectId)
  const share = (await listProjectRows()).find((r) => r.sharedFrom === projectId && r.owner === userId && !r.shareRevoked)
  if (!share) throw new ServerError('NOT_FOUND', `project ${projectId} is not shared with user ${userId}`)
  // First, so nothing can start in it while its workspaces stop.
  await setProjectShareRevoked(share.id, true)
  for (const p of listProvisioning().filter((e) => e.projectId === share.id)) stopProvisioning(p.workspaceId)
  let running: RuntimeHandle[]
  try {
    running = await workspaceDriver().list(share.id)
  } catch (err) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The share was removed, but its workspaces could not be listed '
      + `(${err instanceof Error ? err.message : String(err)}); the server stops them once the runtime is reachable.`)
  }
  await stopInRevokedShare(share, running)
}

/**
 * Stop whatever still runs in a removed share: a workspace whose stop
 * failed when the share was removed, or a create or restart that had
 * passed its owner check by then. Level-triggered, so it runs every pass;
 * a share that fails is logged and retried next pass, without holding up
 * the others.
 */
export async function reconcileRevokedShares(snapshot: RuntimeSnapshot): Promise<void> {
  const revoked = (await listProjectRows()).filter((r) => r.shareRevoked)
  if (revoked.length === 0) return
  const running = await snapshot.workspaces()
  for (const share of revoked) {
    await stopInRevokedShare(share, running.filter((h) => h.projectId === share.id && !h.terminating))
      .catch((err: unknown) => serverLog(`[server] stopping removed share ${share.id}: ${String(err)}`))
  }
}

/**
 * Tear down a removed share's workspaces among `handles`, keeping their
 * checkouts, after adopting any token their agents refreshed, as a stop
 * does. Spares are left to the prewarm pool, which reaps them once the
 * project has no running workspace. Throws RUNTIME_UNAVAILABLE naming the
 * ones that could not be stopped.
 */
async function stopInRevokedShare(share: ProjectRow, handles: RuntimeHandle[]): Promise<void> {
  const own = handles.filter((h) => !h.prewarmed)
  if (own.length === 0) return
  await harvestToolCredentials(share.owner, { projectId: share.id })
    .catch((err: unknown) => serverLog(`[server] credential harvest for removed share ${share.id} failed: ${String(err)}`))
  const failed: string[] = []
  for (const h of own) {
    await cleanupWorkspaceDetached({ jobName: h.jobName, projectId: share.id, workspaceId: h.workspaceId })
      .catch((err: unknown) => { failed.push(`${h.workspaceId.slice(0, 8)}: ${String(err)}`) })
  }
  if (failed.length > 0) {
    throw new ServerError('RUNTIME_UNAVAILABLE', 'The share was removed, but some of its workspaces could not be '
      + `stopped yet (${failed.join('; ')}); the server keeps trying.`)
  }
}

async function deleteProject(projectId: string): Promise<void> {
  await purgeProjectBytes(projectId)
  // The macOS Keychain item containerless claude keys on the tool home path.
  // No-op elsewhere.
  dropProjectClaudeKeychainItem(projectId)

  await deleteProjectWorkspaces(projectId)
  await deleteProjectAgentSessions(projectId)
  await deleteProjectWorkspaceGroups(projectId)
  // Entries first: a run's entry references its routine.
  await deleteProjectQueuedWorkspaces(projectId)
  await deleteProjectRoutines(projectId)
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
  await removeEntries(getProjectsDir(), [projectId])
  // A hosted project's remote is its only authoritative copy; the remove
  // confirmation says so. A share has none of its own.
  await fs.rm(hostedRepoDir(projectId), { recursive: true, force: true })
}
