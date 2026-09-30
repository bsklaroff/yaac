import { api } from './api'

/**
 * Forward a detected-but-unforwarded container port for a workspace.
 * `persist: false` opens a live forward for just this running workspace;
 * `persist: true` also writes the port into the project's yaac-config.json
 * (so future workspaces inherit it) and fans the live forward out to the
 * project's other running workspaces. Either way the server pushes a fresh
 * snapshot that moves the port from `unforwardedPorts` to `forwardedPorts`,
 * so the badge updates on its own.
 */
export async function forwardDetectedPort(
  workspaceId: string,
  containerPort: number,
  opts: { persist: boolean },
): Promise<void> {
  await api.workspace[':id']['forward-port'].$post({
    param: { id: workspaceId },
    json: { containerPort, persist: opts.persist },
  })
}

/**
 * Hide a detected port for this workspace (server-side, in-memory — resets on
 * server restart). The pushed snapshot drops it from `unforwardedPorts`.
 */
export async function dismissDetectedPort(
  workspaceId: string,
  containerPort: number,
): Promise<void> {
  await api.workspace[':id']['dismiss-port'].$post({
    param: { id: workspaceId },
    json: { containerPort },
  })
}
