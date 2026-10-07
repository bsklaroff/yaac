import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspaceDetached } from './cleanup'
import { resolveWorkspaceId } from './resolve'
import { startQueuedChildren } from './queued-workspaces'
import { listProvisioning, stopProvisioning } from './provisioning'
import { authorizeProject, type Actor } from '#domain/access'
import { harvestToolCredentials } from '#domain/auth'
import { serverLog } from '#log'
import { ServerError } from '@yaac/shared/errors'

export interface StoppedWorkspaceInfo {
  workspaceId: string
  projectId: string
  /** Set when it was still being created or restarted, so there is nothing
   *  to tear down yet: a create becomes a draft, a restart stays stopped. */
  provisioning?: true
}

/**
 * Stop a workspace by id or prefix: schedule a detached teardown, keeping the
 * checkout for restart. This is the only natural stop (user or `yaac-mama
 * stop`; deaths and restarts do not come here), so it also launches the
 * workspaces queued after this one (docs/queued-workspaces.md). Throws
 * `NOT_FOUND` or `RUNTIME_UNAVAILABLE`.
 *
 * A workspace still provisioning is stopped by rolling its create back
 * (`stopProvisioning`); one that gets its agent running first is stopped
 * here once it does.
 */
export async function stopWorkspace(principal: Actor, idOrPrefix: string): Promise<StoppedWorkspaceInfo> {
  const workspaceId = await resolveWorkspaceId(idOrPrefix, { provisioning: true })
  const pending = listProvisioning().find((p) => p.workspaceId === workspaceId)
  if (pending !== undefined) await authorizeProject(principal, pending.projectId)
  const provisioning = stopProvisioning(workspaceId)
  if (provisioning !== undefined) {
    void provisioning.ranAs
      .then((ranAs) => (ranAs === undefined ? undefined : stopRunning(principal, ranAs, ranAs)))
      .catch((err: unknown) => serverLog(`[server] stopping ${workspaceId} once provisioned failed: ${String(err)}`))
    return { workspaceId, projectId: provisioning.projectId, provisioning: true }
  }
  return await stopRunning(principal, workspaceId, idOrPrefix)
}

async function stopRunning(principal: Actor, workspaceId: string, idOrPrefix: string): Promise<StoppedWorkspaceInfo> {
  const target = await workspaceDriver().findForTeardown(workspaceId)
  if (!target) {
    throw new ServerError(
      'NOT_FOUND',
      `No workspace found matching "${idOrPrefix}". Run "yaac workspace list" to see running workspaces.`,
    )
  }
  await authorizeProject(principal, target.projectId)

  // Adopt any token the agent refreshed (without a proxy it exists only in
  // the project's tool home). Best-effort.
  await harvestToolCredentials({ projectId: target.projectId })
    .catch((err: unknown) => serverLog(`[server] credential harvest on stop failed: ${String(err)}`))

  await cleanupWorkspaceDetached({
    jobName: target.unitName,
    projectId: target.projectId,
    workspaceId: target.workspaceId,
  })
  // No need to wait for the runtime to be gone. On failure, the reconcile
  // step launches whatever was released.
  await startQueuedChildren(target.projectId, target.workspaceId)
    .catch((err: unknown) => serverLog(`[server] starting queued workspaces on stop failed: ${String(err)}`))
  return {
    workspaceId: target.workspaceId,
    projectId: target.projectId,
  }
}
