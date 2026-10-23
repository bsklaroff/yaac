import { api } from '#commands/api'
import { attachStarted, durationOption } from '#commands/workspace-create'

/**
 * `yaac workspace restart <id>`: ask the server to restart the workspace,
 * keeping its checkout and resuming every agent session that was live when
 * it stopped, then attach to it. `--timeout` stops it that long after the
 * restart; without one the restart clears any timeout it had.
 */
export async function workspaceRestart(workspaceId: string, opts: { timeout?: string } = {}): Promise<void> {
  const timeout = opts.timeout !== undefined ? durationOption('--timeout', opts.timeout) : undefined
  await attachStarted(await api.workspace.restart.$post({ json: { workspaceId, timeout } }))
}
