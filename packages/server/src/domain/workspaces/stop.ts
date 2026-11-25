import { workspaceDriver } from '#drivers/driver'
import { cleanupWorkspaceDetached } from './cleanup'
import { resolveWorkspaceId } from './resolve'
import { startQueuedChildren, startWaitingWorkspaces } from './queued-workspaces'
import { listProvisioning, stopProvisioning } from './provisioning'
import { authorizeProject, requirePerson, type Actor } from '#domain/access'
import { findWorkspaceRow, getSiteRow, listProjectSites } from '#db'
import { harvestToolCredentials } from '#domain/auth'
import { getProjectRow } from '#db'
import { serverLog } from '#lib/log'
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
 * workspaces queued after this one (docs/queued-workspaces.md), along with
 * any waiting for the slot it frees in its group. Throws
 * `NOT_FOUND` or `RUNTIME_UNAVAILABLE`.
 *
 * A workspace still provisioning is stopped by rolling its create back
 * (`stopProvisioning`); one that gets its agent running first is stopped
 * here once it does.
 */
export async function stopWorkspace(principal: Actor, idOrPrefix: string): Promise<StoppedWorkspaceInfo> {
  const workspaceId = await resolveWorkspaceId(idOrPrefix, { provisioning: true })
  // Checked against what the server recorded before the substrate is
  // asked, so a non-owner is refused whatever state the workspace is in.
  const row = await findWorkspaceRow(workspaceId)
  const recorded = listProvisioning().find((p) => p.workspaceId === workspaceId || p.claimedId === workspaceId) ?? row
  if (recorded) await authorizeProject(principal, recorded.projectId, 'delegate')
  if (recorded && principal.kind !== 'system' && (row === undefined || row.siteId !== undefined)) {
    await checkSiteRelease(principal, recorded.projectId, row?.siteId, workspaceId)
  }
  const provisioning = stopProvisioning(workspaceId)
  if (provisioning !== undefined) {
    // A rolled-back create or restart frees its slot in its group.
    void provisioning.ranAs
      .then(async (ranAs) => {
        if (ranAs === undefined) await startWaitingWorkspaces(provisioning.projectId)
        else await stopRunning(principal, ranAs, ranAs)
      })
      .catch((err: unknown) => serverLog(`[server] stopping ${workspaceId} once provisioned failed: ${String(err)}`))
    return { workspaceId, projectId: provisioning.projectId, provisioning: true }
  }
  return await stopRunning(principal, workspaceId, idOrPrefix)
}

/**
 * Refuse a stop of a site's release that is its site's to make
 * (docs/public-sites.md "Deploys"): the live or draining release, so no
 * one takes a site down by accident, and a published site's deploy unless
 * a person cancels it, as only a person may stop a published site. An
 * unpublished site's deploy, and a release its site no longer tracks (a
 * stop that failed, a deleted site), are the owner's to stop. A release
 * still provisioning has no row naming its site yet, so its site is found
 * by the deploy that started it.
 */
async function checkSiteRelease(principal: Actor, projectId: string, siteId: string | undefined, workspaceId: string): Promise<void> {
  const site = siteId !== undefined
    ? await getSiteRow(siteId)
    : (await listProjectSites(projectId)).find((s) => s.deployWorkspaceId === workspaceId)
  if (site === undefined) return
  if ([site.liveWorkspaceId, site.drainWorkspaceId].includes(workspaceId)) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId.slice(0, 8)} is a site's release; `
      + 'stop the site with `yaac site stop`')
  }
  if (site.published && site.deployWorkspaceId === workspaceId) requirePerson(principal, 'cancel a published site\'s deploy')
}

async function stopRunning(principal: Actor, workspaceId: string, idOrPrefix: string): Promise<StoppedWorkspaceInfo> {
  const target = await workspaceDriver().findForTeardown(workspaceId)
  if (!target) {
    throw new ServerError(
      'NOT_FOUND',
      `No workspace found matching "${idOrPrefix}". Run "yaac workspace list" to see running workspaces.`,
    )
  }
  await authorizeProject(principal, target.projectId, 'delegate')

  // Adopt any token the agent refreshed (without a proxy it exists only in
  // the project's tool home). Best-effort.
  await getProjectRow(target.projectId)
    .then((row) => row && harvestToolCredentials(row.owner, { projectId: target.projectId }))
    .catch((err: unknown) => serverLog(`[server] credential harvest on stop failed: ${String(err)}`))

  await cleanupWorkspaceDetached({
    jobName: target.unitName,
    projectId: target.projectId,
    workspaceId: target.workspaceId,
  })
  // No need to wait for the runtime to be gone. What a failure here leaves
  // released launches at the project's next freed slot, or the next boot.
  await startQueuedChildren(target.projectId, target.workspaceId)
    .catch((err: unknown) => serverLog(`[server] starting queued workspaces on stop failed: ${String(err)}`))
  return {
    workspaceId: target.workspaceId,
    projectId: target.projectId,
  }
}
