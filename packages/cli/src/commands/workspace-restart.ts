import { api } from '#commands/api'
import { attachStarted, durationOption, followNonInteractive } from '#commands/workspace-create'
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
  opts: { timeout?: string; volume?: string | false; restoreNewest?: boolean } = {},
): Promise<void> {
  const timeout = opts.timeout !== undefined ? durationOption('--timeout', opts.timeout) : undefined
  // Commander's `--no-volume` sets `volume: false`.
  const volume = opts.volume === false ? null : opts.volume
  try {
    await attachStarted(await api.workspace.restart.$post({
      json: { workspaceId, timeout, volume, ...(opts.restoreNewest === true ? { restoreNewest: true } : {}) },
    }))
  } catch (err) {
    if (err instanceof ServerError && err.code === 'VOLUME_HELD') {
      throw new Error(`${err.message}\nRestart it without the volume with: yaac workspace restart --no-volume ${workspaceId}`)
    }
    throw err
  }
}

/**
 * `yaac workspace rerun <id>`: start a new non-interactive workspace running
 * the steps of the one `<id>` names, at the commit it ran at
 * (docs/workspace-steps.md), and say how to follow it, or with `--wait`
 * wait for its outcome. `--interactive` starts an interactive workspace
 * there instead, with those steps as its start steps, to reproduce a
 * failure in.
 */
export async function workspaceRerun(
  workspaceId: string,
  opts: { interactive?: boolean; wait?: boolean } = {},
): Promise<void> {
  if (opts.interactive === true && opts.wait === true) throw new Error('--wait goes with a non-interactive rerun: an interactive one runs until stopped.')
  const res = await api.workspace.rerun.$post({ json: { workspaceId, ...(opts.interactive === true ? { interactive: true } : {}) } })
  if (opts.interactive === true) await attachStarted(res)
  else await followNonInteractive(res, { wait: opts.wait === true })
}
