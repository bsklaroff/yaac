import { workspaceDriver } from '#drivers/driver'
import { addPortForwardToProjectConfig } from '#domain/projects'
import { resolveWorkspaceContainer } from './resolve'
import { ServerError } from '@yaac/shared/errors'
import type { PortMapping } from '@yaac/shared/types'

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
  idOrName: string,
  containerPort: number,
  opts: { persist: boolean },
): Promise<PortMapping> {
  const runtime = workspaceDriver()
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true })
  if (!(await runtime.unforwardedPorts(target.workspaceId)).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.workspaceId.slice(0, 8)}`,
    )
  }
  if (opts.persist) await addPortForwardToProjectConfig(target.projectSlug, containerPort)
  return runtime.forwardPort(
    { workspaceId: target.workspaceId, projectSlug: target.projectSlug, jobName: target.jobName },
    containerPort,
    { fanOutToProject: opts.persist },
  )
}

/**
 * Hide a suggested port (the webapp's dismiss action). Only a currently
 * unforwarded listener is accepted, with the same CONFLICT as
 * `forwardWorkspacePort`. In memory only.
 */
export async function dismissWorkspacePort(
  idOrName: string,
  containerPort: number,
): Promise<void> {
  const target = await resolveWorkspaceContainer(idOrName, { requireRunning: true })
  if (!workspaceDriver().dismissPort(target.workspaceId, containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.workspaceId.slice(0, 8)}`,
    )
  }
}
