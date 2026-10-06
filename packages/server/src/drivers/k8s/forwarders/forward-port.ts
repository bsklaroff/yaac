import { isPrewarmed, readWorkspacePods, relayDial } from '#drivers/k8s/substrate'
import { addWorkspaceForwarder, getWorkspacePorts } from './port-forwarders'
import { getUnforwardedPorts, isDetectedPort } from './port-detector'
import { ServerError } from '@yaac/shared/errors'
import { serverLog } from '#log'
import type { Duplex } from 'node:stream'
import type { PortMapping } from '@yaac/shared/types'

/**
 * Forward a detected-but-unforwarded port on a running workspace (the
 * webapp's click-to-forward action). Only a port in the workspace's current
 * unforwarded set is accepted, never an arbitrary one.
 *
 * The forward lives only in this server's in-memory registry. Persisting it
 * is the caller's job (`#domain/workspaces` writes the project config, then
 * asks for `fanOutToProject`). The fan-out to the project's other running
 * workspaces is best-effort; a failure on the target itself is thrown.
 */
export async function forwardWorkspacePort(
  target: { workspaceId: string; projectId: string; jobName: string },
  containerPort: number,
  opts: { fanOutToProject: boolean },
): Promise<PortMapping> {
  if (!getUnforwardedPorts(target.workspaceId).includes(containerPort)) {
    throw new ServerError(
      'CONFLICT',
      `port ${containerPort} is not an unforwarded listener in session ${target.workspaceId.slice(0, 8)}`,
    )
  }

  const mapping = await addWorkspaceForwarder(target.workspaceId, target.jobName, containerPort)

  if (opts.fanOutToProject) {
    const pods = await readWorkspacePods(target.projectId)
    await Promise.all(
      pods
        .filter((p) => p.running && p.workspaceId && p.workspaceId !== target.workspaceId && !isPrewarmed(p))
        .map((p) =>
          addWorkspaceForwarder(p.workspaceId, p.jobName, containerPort)
            .catch((err: unknown) => {
              serverLog(
                `[server] forward-port fan-out to ${p.workspaceId.slice(0, 8)} failed: `
                + (err instanceof Error ? err.message : String(err)),
              )
            })),
    )
  }

  return mapping
}

/**
 * Open one forwarded TCP connection: a `tcp` stream through the pod's
 * streamd to a port inside the workspace. One dial per client connection.
 * The caller owns the returned stream: `relayDial` hands it back paused, so
 * the caller resumes it once its reader is attached, and destroys it to
 * end the connection.
 *
 * Only a declared port or one the detector surfaced may be dialled, which
 * keeps yaac's own in-pod ports unreachable. A declared port is dialled
 * even if nothing listens yet, so a forward survives a dev server restart.
 */
export function dialWorkspacePort(
  workspaceId: string,
  containerPort: number,
): Promise<Duplex> {
  const declared = getWorkspacePorts(workspaceId).some((p) => p.containerPort === containerPort)
  if (!declared && !isDetectedPort(workspaceId, containerPort)) {
    return Promise.reject(new Error(
      `port ${String(containerPort)} is neither declared nor a detected listener of this workspace`,
    ))
  }
  return relayDial(workspaceId, { kind: 'tcp', port: containerPort })
}
