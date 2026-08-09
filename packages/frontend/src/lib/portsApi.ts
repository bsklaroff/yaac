import { api } from './api'

/**
 * Forward a detected-but-unforwarded container port for a worktree.
 * `persist: false` opens a live forward for just this running worktree;
 * `persist: true` also writes the port into the project's yaac-config.json
 * (so future worktrees inherit it) and fans the live forward out to the
 * project's other running worktrees. Either way the server pushes a fresh
 * snapshot that moves the port from `unforwardedPorts` to `forwardedPorts`,
 * so the badge updates on its own.
 */
export async function forwardDetectedPort(
  worktreeId: string,
  containerPort: number,
  opts: { persist: boolean },
): Promise<void> {
  await api.worktree[':id']['forward-port'].$post({
    param: { id: worktreeId },
    json: { containerPort, persist: opts.persist },
  })
}

/**
 * Hide a detected port for this worktree (server-side, in-memory — resets on
 * server restart). The pushed snapshot drops it from `unforwardedPorts`.
 */
export async function dismissDetectedPort(
  worktreeId: string,
  containerPort: number,
): Promise<void> {
  await api.worktree[':id']['dismiss-port'].$post({
    param: { id: worktreeId },
    json: { containerPort },
  })
}
