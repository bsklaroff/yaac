import { workspaceDriver } from '#drivers/driver'
import { addPortForwardToProjectConfig } from '#domain/projects'
import { resolveWorkspaceContainer } from './resolve'
import { ServerError } from '@yaac/shared/errors'
import type { PortMapping } from '@yaac/shared/types'
import type { Actor } from '#domain/access'

/**
 * Forward a port a workspace is listening on but that is not yet forwarded
 * (the webapp's click-to-forward). Like `allowWorkspaceHost`, `persist`
 * writes it to yaac-config.json and also forwards it in the project's other
 * running workspaces.
 *
 * Eligibility is checked before the config write, so a refused request
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
  if (opts.persist) await addPortForwardToProjectConfig(principal, target.projectId, containerPort)
  return runtime.forwardPort(
    { workspaceId: target.workspaceId, projectId: target.projectId, jobName: target.jobName },
    containerPort,
    { fanOutToProject: opts.persist },
  )
}

/**
 * Stop forwarding one of a running workspace's ports (the webapp's "stop
 * forwarding" action), for this workspace only: the project config is left
 * alone, so a port declared there is forwarded again after a server
 * restart. A port that is not forwarded is a CONFLICT.
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
