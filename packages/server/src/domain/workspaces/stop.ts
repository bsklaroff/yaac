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
 * Resolve a workspace by its id or unique prefix and schedule a
 * detached cleanup (delete the Job + prune the workspace dirs). The *git
 * workspace* is deliberately kept — that is what makes this a stop rather
 * than a delete, and what a later restart re-attaches to.
 *
 * This is a NATURAL stop — the user's, or an agent's `yaac-mama stop` — and
 * the only one: a death, a restart's teardown and a failed resume never come
 * through here. So it is where the workspaces queued after this one are
 * started (docs/queued-workspaces.md). Throws
 * `NOT_FOUND` if nothing matches, `RUNTIME_UNAVAILABLE` if the cluster
 * can't be reached.
 */
export async function stopWorkspace(idOrPrefix: string): Promise<StoppedWorkspaceInfo> {
  const target = await workspaceDriver().findForTeardown(await resolveWorkspaceId(idOrPrefix))
  if (!target) {
    throw new ServerError(
      'NOT_FOUND',
      `No workspace found matching "${idOrPrefix}". Run "yaac workspace list" to see running workspaces.`,
    )
  }

  // Last chance to notice a token this workspace's agent refreshed. Under an
  // unmediated runtime that refresh landed in the project's tool home and
  // nowhere else, and stopping removes the thing whose liveness was holding
  // the host's own refresh back — so adopt it now rather than leaving the
  // host store stale until the next sweep. Best-effort: a stop must not fail
  // because a credential could not be read.
  await harvestToolCredentials({ slug: target.projectSlug })
    .catch((err: unknown) => serverLog(`[server] credential harvest on stop failed: ${String(err)}`))

  await cleanupWorkspaceDetached({
    jobName: target.unitName,
    projectSlug: target.projectSlug,
    workspaceId: target.workspaceId,
  })
  // Once the stop is recorded, not once the runtime is gone: a child has its
  // own checkout and runtime, and nothing of the parent's in its way. A
  // failure here leaves the stop done; the reconcile step launches whatever
  // was released and not started.
  await startQueuedChildren(target.projectSlug, target.workspaceId)
    .catch((err: unknown) => serverLog(`[server] starting queued workspaces on stop failed: ${String(err)}`))
  return {
    jobName: target.unitName,
    workspaceId: target.workspaceId,
    projectSlug: target.projectSlug,
  }
}
