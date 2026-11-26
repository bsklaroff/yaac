import { workspaceDriver } from '#drivers/driver'
import { listProjectRows } from '#db'
import { serverLog } from '#lib/log'
import { stopWorkspaces } from './repo-teardown'

/**
 * Stop every workspace the driver says runs on a runtime of an older
 * shape (`WorkspaceDriver.outdatedWorkspaces`), as a user's stop would:
 * its last checkpoint is taken on the way down, and a restart brings it
 * back in the current shape. A turn that was running is lost. A site's
 * live release is stopped too, which a user's stop refuses; the site then
 * replaces it as it does an evicted one (docs/public-sites.md "A live
 * release whose runtime is gone"). Level-triggered, so it runs every pass;
 * a workspace that fails is logged and retried next pass
 * (docs/legacy-compat-shims.md "Workspaces on the gvisor class").
 */
export async function reconcileOutdatedWorkspaces(): Promise<void> {
  const outdated = await workspaceDriver().outdatedWorkspaces()
  if (outdated.length === 0) return
  serverLog(`[server] stopping ${String(outdated.length)} workspace(s) on a runtime from an older yaac: `
    + outdated.map((h) => h.workspaceId.slice(0, 8)).join(', '))
  const failed = await stopWorkspaces(outdated, await listProjectRows())
  if (failed.length > 0) serverLog(`[server] stopping workspaces of an older runtime: ${failed.join('; ')}`)
}
