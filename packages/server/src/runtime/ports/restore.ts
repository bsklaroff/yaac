import { worktreeDriver } from '#drivers/driver'
import { isTmuxSessionAlive } from '#runtime/status'
import { reserveAvailablePort } from '#lib/port'
import type { ReservedPort } from '#lib/port'
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
  worktreeId: string,
  ports: ReadonlyArray<PortMapping>,
): Promise<void> {
  await worktreeDriver().exec(
    jobName,
    setStatusRightCmd(buildStatusRight(projectSlug, worktreeId, ports)),
  )
}

/**
 * Rebuild port forwarders for every live workspace.
 *
 * The forwarder registry is in-memory, so a server restart loses it while
 * the workspaces keep running with a tmux `status-right` still advertising
 * ports that are no longer forwarded. Without this pass the bars lie. Run
 * once as the server attaches, before it serves anything.
 *
 * Every step is skipped rather than retried: a workspace that isn't running,
 * one that already has forwarders (nothing was lost), and one whose tmux is
 * gone (the reaper's business, not this pass's).
 *
 * Driver-neutral: reserving a host port and deciding which ports a workspace
 * should carry are the same over any substrate — only putting relays behind
 * the bound sockets is the driver's, and that is `startForwarders`. WHICH
 * ports come from the project's config, so the caller supplies the reader —
 * a plain parameter rather than a `PassContext` accessor, because this runs
 * once as the server attaches and there is no pass to take one from.
 */
export async function restoreAllWorkspaceForwarders(
  projectConfig: (slug: string) => Promise<YaacConfig | undefined>,
): Promise<void> {
  const runtime = worktreeDriver()
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
 * Reserve host ports, hand them to the driver's forwarders, and refresh the
 * status bar to match.
 *
 * Reservation happens here rather than in the driver for the same reason the
 * launch path binds its own: a bound socket is the only thing that stops
 * another process taking the port, and a caller that gives up must close it
 * rather than start relays.
 */
async function provisionForwarders(
  projectSlug: string,
  worktreeId: string,
  jobName: string,
  portForward: PortForwardConfig[] | undefined,
): Promise<void> {
  const reserved: ReservedPort[] = []
  if (portForward?.length) {
    for (const { containerPort, hostPortStart } of portForward) {
      reserved.push(await reserveAvailablePort(containerPort, hostPortStart))
    }
  }

  // Always refresh status-right — even with no port forwards, the workspace's
  // existing string may carry stale port info from before the restart that
  // has to be cleared.
  await setWorkspaceStatusRight(jobName, projectSlug, worktreeId, reserved)

  if (reserved.length === 0) return
  worktreeDriver().startForwarders(worktreeId, reserved)
}
