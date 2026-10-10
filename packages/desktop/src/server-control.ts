/**
 * This machine's servers, as the tray and the connect page drive them. A
 * Mac can have two installs side by side (docs/server-selection.md): the
 * host server (`yaac server status|start|stop|restart`) and a cluster
 * install's Deployment (`yaac cluster status|start|stop`). Both are driven
 * through the `yaac` on PATH, so they act on the same installs a terminal
 * would.
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

/** A read: `server status`, `cluster status` or `host check`. */
export const READ_TIMEOUT_MS = 15_000
/**
 * A start, stop or restart. It covers `server start`'s ready wait and a
 * cluster rollout or pod drain.
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

/** Which install: the host server or the cluster's (`yaac server …` / `yaac cluster …`). */
export type ServerScope = 'server' | 'cluster'

export type LocalServerState =
  | { kind: 'status', status: LocalServerStatus }
  /** No `yaac` on PATH: an app installed without the yaac-server formula. */
  | { kind: 'no-cli' }
  | { kind: 'error', message: string }

/** Both of this Mac's installs, each null until first read. */
export interface LocalServers {
  server: LocalServerState | null
  cluster: LocalServerState | null
}

export async function readLocalServer(run: RunYaac, scope: ServerScope): Promise<LocalServerState> {
  let result: YaacResult
  try {
    result = await run([scope, 'status', '--json'], READ_TIMEOUT_MS)
  } catch {
    return { kind: 'no-cli' }
  }
  if (!result.ok) return { kind: 'error', message: result.stderr.trim() || `yaac ${scope} status failed` }
  try {
    return { kind: 'status', status: JSON.parse(result.stdout) as LocalServerStatus }
  } catch {
    return { kind: 'error', message: `yaac ${scope} status printed no status` }
  }
}

/** The cluster's status, when this Mac has a cluster install. */
export function clusterStatus(local: LocalServers): LocalServerStatus | null {
  return local.cluster?.kind === 'status' && local.cluster.status.driver === 'k8s' ? local.cluster.status : null
}

/**
 * The host server's status. Null when `~/.yaac` is itself a cluster install
 * (from before the two had separate data dirs), which the cluster lines
 * already describe.
 */
export function hostStatus(local: LocalServers): LocalServerStatus | null {
  return local.server?.kind === 'status' && local.server.status.driver !== 'k8s' ? local.server.status : null
}

export type ServerAction = 'start' | 'stop' | 'restart'

export interface ScopedAction {
  scope: ServerScope
  action: ServerAction
}

/** A tray line; one without an action is a disabled label. */
export interface TrayServerItem {
  label: string
  action?: ScopedAction
}

const NOUN: Record<ServerScope, string> = { server: 'this Mac\'s server', cluster: 'this Mac\'s cluster server' }
const BUSY: Record<ServerAction, string> = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }
const VERB: Record<ServerAction, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' }

function line(scope: ServerScope, state: string): TrayServerItem {
  const noun = NOUN[scope]
  return { label: `${noun[0].toUpperCase()}${noun.slice(1)}: ${state}` }
}

function act(scope: ServerScope, action: ServerAction, suffix = ''): TrayServerItem {
  return { label: `${VERB[action]} ${NOUN[scope]}${suffix}`, action: { scope, action } }
}

/**
 * The tray's server lines: for each install a state label and at most one
 * action. They always name this Mac's servers, since the window may be on a
 * remote one. A host server on a different build than the installed CLI
 * (after `brew upgrade`) offers a restart instead of a stop. A cluster's
 * server is updated by `yaac cluster install`, which rebuilds its image, so
 * the tray only names that command.
 */
export function trayServerItems(local: LocalServers, busy: ScopedAction | null): TrayServerItem[] {
  if (busy) return [{ label: `${BUSY[busy.action]} ${NOUN[busy.scope]}…` }]
  const items: TrayServerItem[] = []
  const host = hostStatus(local)
  if (local.server?.kind === 'no-cli') items.push({ label: 'No yaac CLI on PATH' })
  else if (local.server?.kind === 'error') items.push(line('server', 'status unavailable'))
  else if (host && !host.running) items.push(line('server', 'stopped'), act('server', 'start'))
  else if (host && host.serverBuildId === host.cliBuildId) items.push(line('server', 'running'), act('server', 'stop'))
  else if (host) items.push(line('server', 'running an older build'), act('server', 'restart', ' to update'))

  const cluster = clusterStatus(local)
  // An older `yaac` has no `cluster status`, so this asks for an update.
  if (local.cluster?.kind === 'error') items.push(line('cluster', 'status unavailable'))
  else if (cluster?.running === null) items.push({ label: 'This Mac\'s cluster server runs on its cluster' })
  else if (cluster && !cluster.running) items.push(line('cluster', 'stopped'), act('cluster', 'start'))
  else if (cluster && cluster.serverBuildId === cluster.cliBuildId) items.push(line('cluster', 'running'), act('cluster', 'stop'))
  else if (cluster) {
    items.push({ label: 'Update this Mac\'s cluster server with `yaac cluster install`' }, act('cluster', 'stop'))
  }
  return items
}

export type ActionOutcome =
  | { ok: true, hostCheckFailures?: string }
  | { ok: false, error: string }

/**
 * Run `yaac server|cluster <action>`. After a start of the host server,
 * `yaac host check` runs too, and its failing lines come back: the formula
 * installs every tool it requires except the agent CLIs, so in practice it
 * names the agent to install.
 */
export async function runServerAction({ scope, action }: ScopedAction, run: RunYaac): Promise<ActionOutcome> {
  let result: YaacResult
  try {
    result = await run([scope, action], ACTION_TIMEOUT_MS)
  } catch {
    return { ok: false, error: 'yaac is not on PATH. Install it with: brew install bsklaroff/yaac/yaac-server' }
  }
  if (!result.ok) return { ok: false, error: result.stderr.trim() || `yaac ${scope} ${action} failed` }
  if (scope !== 'server' || action !== 'start') return { ok: true }
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
