import { workspaceDriver } from '#drivers/driver'
import { isTmuxSessionAlive } from '#runtime/status'
import { buildStatusRight, setStatusRightCmd } from '#lib/status-right'
import { serverLog } from '#log'
import type { PortForwardConfig, PortMapping, YaacConfig } from '@yaac/shared/types'

/**
 * Overwrite a running workspace's tmux `status-right`, so the displayed port
 * mapping matches the live forwarders.
 */
async function setWorkspaceStatusRight(
  jobName: string,
  projectSlug: string,
  workspaceId: string,
  ports: ReadonlyArray<PortMapping>,
): Promise<void> {
  const driver = workspaceDriver()
  await driver.exec(
    jobName,
    setStatusRightCmd(
      buildStatusRight(projectSlug, workspaceId, ports),
      driver.workspacePaths(jobName).tmuxSock,
    ),
  )
}

/**
 * Rebuild port forwarders for every live workspace. The forwarder registry
 * is in-memory, so after a server restart running workspaces would still
 * advertise ports in their tmux `status-right`. Run once at attach.
 *
 * Skips (never retries) workspaces that are not running, already have
 * forwarders, or whose tmux is gone (the reaper's job).
 *
 * The caller supplies the project-config reader, since this runs once at
 * attach with no `PassContext` to use.
 */
export async function restoreAllWorkspaceForwarders(
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
): Promise<void> {
  const runtime = workspaceDriver()
  let workspaces
  try {
    workspaces = await runtime.list()
  } catch (err) {
    serverLog(`[server] restore forwarders: list workspaces failed: ${String(err)}`)
    return
  }

  const candidates = []
  for (const w of workspaces) {
    if (!w.running || !w.workspaceId || !w.projectSlug || !w.jobName) continue
    if ((await runtime.forwardedPorts(w.workspaceId)).length > 0) continue
    if (!(await isTmuxSessionAlive(w))) continue
    candidates.push(w)
  }

  await Promise.allSettled(candidates.map(async (w) => {
    try {
      const config = await projectConfig(w.projectSlug) ?? {}
      await provisionForwarders(w.projectSlug, w.workspaceId, w.jobName, config.portForward)
    } catch (err) {
      serverLog(
        `[server] restore forwarders for ${w.workspaceId.slice(0, 8)}: `
        + (err instanceof Error ? err.message : String(err)),
      )
    }
  }))
}

/**
 * Re-declare the workspace's forwards with the driver and refresh its
 * status bar. No host port is bound here: the listener is a client's under
 * k8s and the workspace's own under containerless.
 */
async function provisionForwarders(
  projectSlug: string,
  workspaceId: string,
  jobName: string,
  portForward: PortForwardConfig[] | undefined,
): Promise<void> {
  const declared = workspaceDriver().declareForwards(workspaceId, portForward ?? [])

  // Always refresh, to clear stale port info even when there are no
  // forwards.
  await setWorkspaceStatusRight(jobName, projectSlug, workspaceId, declared)
}
