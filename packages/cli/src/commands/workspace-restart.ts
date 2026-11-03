import { api } from '#commands/api'
import { attachStarted, durationOption } from '#commands/workspace-create'
import { ServerError } from '@yaac/shared/errors'

/**
 * `yaac workspace restart <id>`: ask the server to restart the workspace,
 * keeping its checkout and resuming every agent session that was live when
 * it stopped, then attach to it. `--timeout` stops it that long after the
 * restart; without one the restart clears any timeout it had. It attaches
 * the volume it last held, `--volume` another, and `--no-volume` none
 * (docs/workspace-volumes.md).
 */
export async function workspaceRestart(
  workspaceId: string,
  opts: { timeout?: string; volume?: string | false } = {},
): Promise<void> {
  const timeout = opts.timeout !== undefined ? durationOption('--timeout', opts.timeout) : undefined
  // Commander's `--no-volume` sets `volume: false`.
  const volume = opts.volume === false ? null : opts.volume
  try {
    await attachStarted(await api.workspace.restart.$post({ json: { workspaceId, timeout, volume } }))
  } catch (err) {
    if (err instanceof ServerError && err.code === 'VOLUME_HELD') {
      throw new Error(`${err.message}\nRestart it without the volume with: yaac workspace restart --no-volume ${workspaceId}`)
    }
    throw err
  }
}
