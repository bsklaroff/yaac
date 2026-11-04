import { workspaceDriver } from '#drivers/driver'
import { getSiteRow } from '#db'
import { addPortForward } from '#domain/projects'
import { resolveWorkspaceContainer } from './resolve'
import { ServerError } from '@yaac/shared/errors'
import type { PortForwardConfig, PortMapping } from '@yaac/shared/types'
import type { Actor } from '#domain/access'

/**
 * The ports a workspace offers, at launch and again when a server restart
 * declares them anew: its project's forwarded ports, or for a public site's
 * release only its site's admin port, if it has one. A release faces the
 * internet only through the router, and `dialPort` reaches no port a
 * workspace does not offer, so this is all of a release that a forward or
 * preview can reach (docs/public-sites.md "Admin port").
 */
export async function offeredForwards(
  portForwards: PortForwardConfig[],
  siteId: string | undefined,
): Promise<PortForwardConfig[]> {
  if (siteId === undefined) return portForwards
  const adminPort = (await getSiteRow(siteId))?.adminPort
  return adminPort !== undefined ? [{ containerPort: adminPort, hostPortStart: adminPort }] : []
}

/**
 * Forward a port a workspace is listening on but that is not yet forwarded
 * (the webapp's click-to-forward). Like `allowWorkspaceHost`, `persist`
 * adds it to the project's forwarded ports and also forwards it in the
 * project's other running workspaces.
 *
 * Eligibility is checked before the project write, so a refused request
 * leaves nothing persisted. `forwardPort` checks again authoritatively.
 */
export async function forwardWorkspacePort(
  principal: Actor,
  idOrName: string,
  containerPort: number,
  opts: { persist: boolean },
): Promise<PortMapping> {
  const runtime = workspaceDriver()
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true, owner: principal })
  if (!(await runtime.unforwardedPorts(target.workspaceId)).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.workspaceId.slice(0, 8)}`,
    )
  }
  if (opts.persist) await addPortForward(principal, target.projectId, containerPort)
  return runtime.forwardPort(
    { workspaceId: target.workspaceId, projectId: target.projectId, jobName: target.jobName },
    containerPort,
    { fanOutToProject: opts.persist },
  )
}

/**
 * Stop forwarding one of a running workspace's ports (the webapp's "stop
 * forwarding" action), for this workspace only: the project's forwarded
 * ports are left alone, so a port listed there is forwarded again after a
 * server restart. A port that is not forwarded is a CONFLICT.
 */
export async function unforwardWorkspacePort(
  principal: Actor,
  idOrName: string,
  containerPort: number,
): Promise<void> {
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true, owner: principal })
  const { workspaceId, jobName } = target
  if (!(await workspaceDriver().unforwardPort({ workspaceId, jobName }, containerPort))) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not forwarded in session ${workspaceId.slice(0, 8)}`,
    )
  }
}

/**
 * Hide a suggested port (the webapp's dismiss action). Only a currently
 * unforwarded listener is accepted, with the same CONFLICT as
 * `forwardWorkspacePort`. In memory only.
 */
export async function dismissWorkspacePort(
  principal: Actor,
  idOrName: string,
  containerPort: number,
): Promise<void> {
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true, owner: principal })
  if (!workspaceDriver().dismissPort(target.workspaceId, containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.workspaceId.slice(0, 8)}`,
    )
  }
}
