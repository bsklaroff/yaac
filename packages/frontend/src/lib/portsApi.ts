import { api } from './api'

/**
 * Forward a detected port for a workspace. `persist: false` forwards it for
 * this running workspace only; `persist: true` also writes it into the
 * project's yaac-config.json and forwards it in the project's other running
 * workspaces. The server then pushes a snapshot that moves the port from
 * `unforwardedPorts` to `forwardedPorts`.
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
 * Hide a detected port for this workspace. The server keeps this in memory,
 * so it resets on server restart.
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
