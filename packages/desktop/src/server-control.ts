/**
 * This machine's server, as the tray and the connect page drive it. Both run
 * the `yaac` on PATH (`yaac server status|start|stop|restart`), so they act
 * on the same install a terminal would, whichever command started it: a
 * host server, or a kind install's Deployment, which the CLI scales.
 *
 * Starting and stopping are explicit; quitting the app never stops a server.
 * A containerless workspace is a tmux server that outlives the yaac server
 * (docs/containerless-driver.md), so a stop never stops an agent either.
 */
import { execFile } from 'node:child_process'
import type { LocalServerStatus } from '@yaac/shared/types'

export interface YaacResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Run `yaac <args>`, killing it after `timeoutMs`; a timeout is a failed
 * result, so a hung CLI can never wedge the tray or blank the picker.
 * Rejects only when `yaac` cannot be spawned at all.
 */
export type RunYaac = (args: string[], timeoutMs: number) => Promise<YaacResult>

/** A read: `server status` or `host check`. */
export const READ_TIMEOUT_MS = 15_000
/**
 * A start, stop or restart. It covers `server start`'s ready wait and a k8s
 * rollout or pod drain.
 */
export const ACTION_TIMEOUT_MS = 5 * 60_000

export function createRunYaac(execImpl: typeof execFile = execFile): RunYaac {
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    execImpl('yaac', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') reject(new Error('yaac is not on PATH'))
      else if (err?.killed) resolve({ ok: false, stdout: String(stdout), stderr: `yaac ${args.join(' ')} timed out` })
      else resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export type LocalServerState =
  | { kind: 'status', status: LocalServerStatus }
  /** No `yaac` on PATH: an app installed without the yaac-server formula. */
  | { kind: 'no-cli' }
  | { kind: 'error', message: string }

export async function readLocalServer(run: RunYaac): Promise<LocalServerState> {
  let result: YaacResult
  try {
    result = await run(['server', 'status', '--json'], READ_TIMEOUT_MS)
  } catch {
    return { kind: 'no-cli' }
  }
  if (!result.ok) return { kind: 'error', message: result.stderr.trim() || 'yaac server status failed' }
  try {
    return { kind: 'status', status: JSON.parse(result.stdout) as LocalServerStatus }
  } catch {
    return { kind: 'error', message: 'yaac server status printed no status' }
  }
}

export type ServerAction = 'start' | 'stop' | 'restart'

/** A tray line; one without an action is a disabled label. */
export interface TrayServerItem {
  label: string
  action?: ServerAction
}

const BUSY_LABEL: Record<ServerAction, string> = {
  start: 'Starting this Mac\'s server…',
  stop: 'Stopping this Mac\'s server…',
  restart: 'Restarting this Mac\'s server…',
}

/**
 * The tray's server lines: a state label and at most one action. They always
 * name this Mac's server, since the window may be on a remote one. A server
 * on a different build than the installed CLI (after `brew upgrade`) offers
 * a restart instead of a stop. A kind install's server is updated by
 * `yaac cluster install`, which rebuilds its image, so the tray only names
 * that command.
 */
export function trayServerItems(state: LocalServerState | null, busy: ServerAction | null): TrayServerItem[] {
  if (busy) return [{ label: BUSY_LABEL[busy] }]
  if (!state) return []
  if (state.kind === 'no-cli') return [{ label: 'No yaac CLI on PATH' }]
  if (state.kind === 'error') return [{ label: 'This Mac\'s server: status unavailable' }]
  const { status } = state
  const stop: TrayServerItem = { label: 'Stop this Mac\'s server', action: 'stop' }
  if (status.running === null) return [{ label: 'This Mac\'s server runs on its cluster' }]
  if (!status.running) {
    return [{ label: 'This Mac\'s server: stopped' }, { label: 'Start this Mac\'s server', action: 'start' }]
  }
  if (status.serverBuildId === status.cliBuildId) return [{ label: 'This Mac\'s server: running' }, stop]
  if (status.driver === 'k8s') return [{ label: 'Update this Mac\'s server with `yaac cluster install`' }, stop]
  return [
    { label: 'This Mac\'s server: running an older build' },
    { label: 'Restart this Mac\'s server to update', action: 'restart' },
  ]
}

export type ActionOutcome =
  | { ok: true, hostCheckFailures?: string }
  | { ok: false, error: string }

/**
 * Run `yaac server <action>`. After a start of a containerless server,
 * `yaac host check` runs too, and its failing lines come back: the formula
 * installs every tool it requires except the agent CLIs, so in practice it
 * names the agent to install.
 */
export async function runServerAction(action: ServerAction, run: RunYaac): Promise<ActionOutcome> {
  let result: YaacResult
  try {
    result = await run(['server', action], ACTION_TIMEOUT_MS)
  } catch {
    return { ok: false, error: 'yaac is not on PATH. Install it with: brew install bsklaroff/yaac/yaac-server' }
  }
  if (!result.ok) return { ok: false, error: result.stderr.trim() || `yaac server ${action} failed` }
  if (action !== 'start') return { ok: true }
  const state = await readLocalServer(run)
  if (state.kind !== 'status' || state.status.driver !== 'containerless') return { ok: true }
  const check = await run(['host', 'check'], READ_TIMEOUT_MS)
  if (check.ok) return { ok: true }
  return { ok: true, hostCheckFailures: failedChecks(check.stdout) }
}

/** The `✗` results of `yaac host check`'s output, each with its indented fix. */
function failedChecks(stdout: string): string {
  const blocks: string[][] = []
  for (const line of stdout.split('\n')) {
    if (/^\s/.test(line) && blocks.length > 0) blocks[blocks.length - 1].push(line)
    else if (line.trim() !== '') blocks.push([line])
  }
  return blocks.filter((b) => b[0].startsWith('✗')).map((b) => b.join('\n')).join('\n')
}
