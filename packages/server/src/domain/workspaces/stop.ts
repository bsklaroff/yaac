import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspaceDetached } from './cleanup'
import { resolveWorkspaceId } from './resolve'
import { startQueuedChildren } from './queued-workspaces'
import { harvestToolCredentials } from '#domain/auth'
import { serverLog } from '#log'
import { ServerError } from '@yaac/shared/errors'

export interface StoppedWorkspaceInfo {
  workspaceId: string
  jobName: string
  projectSlug: string
}

/**
 * Stop a workspace by id or prefix: schedule a detached teardown, keeping the
 * checkout for restart. This is the only natural stop (user or `yaac-mama
 * stop`; deaths and restarts do not come here), so it also launches the
 * workspaces queued after this one (docs/queued-workspaces.md). Throws
 * `NOT_FOUND` or `RUNTIME_UNAVAILABLE`.
 */
export async function stopWorkspace(idOrPrefix: string): Promise<StoppedWorkspaceInfo> {
  const target = await workspaceDriver().findForTeardown(await resolveWorkspaceId(idOrPrefix))
  if (!target) {
    throw new ServerError(
      'NOT_FOUND',
      `No workspace found matching "${idOrPrefix}". Run "yaac workspace list" to see running workspaces.`,
    )
  }

  // Adopt any token the agent refreshed (without a proxy it exists only in
  // the project's tool home). Best-effort.
  await harvestToolCredentials({ slug: target.projectSlug })
    .catch((err: unknown) => serverLog(`[server] credential harvest on stop failed: ${String(err)}`))

  await cleanupWorkspaceDetached({
    jobName: target.unitName,
    projectSlug: target.projectSlug,
    workspaceId: target.workspaceId,
  })
  // No need to wait for the runtime to be gone. On failure, the reconcile
  // step launches whatever was released.
  await startQueuedChildren(target.projectSlug, target.workspaceId)
    .catch((err: unknown) => serverLog(`[server] starting queued workspaces on stop failed: ${String(err)}`))
  return {
    jobName: target.unitName,
    workspaceId: target.workspaceId,
    projectSlug: target.projectSlug,
  }
}
