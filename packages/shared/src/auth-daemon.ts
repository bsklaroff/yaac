import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { clientLocalPath, ensureClientLocalRoot } from '#paths'
import { resolveServerTarget, type ServerTarget } from '#server-api'

/** Cold-boot budget shared by automatic connection and explicit startup. */
export const AUTH_DAEMON_BOOT_TIMEOUT_MS = 30_000

/**
 * Client-side lifecycle of the auth server: the login broker that runs on
 * the user's machine, connects out to the (possibly remote) main server,
 * and runs claude/codex sign-in flows where the browser and the vendors'
 * localhost OAuth callbacks are.
 *
 * In `@yaac/shared` because the desktop shell starts it too. The shell is
 * not the yaac CLI, so the launch command and target are overridable.
 */

export interface AuthDaemonLock {
  pid: number
  /** The main-server origin this agent connected to. */
  baseUrl: string
  startedAt: number
}

/** CLIENT-LOCAL: the daemon always runs on the user's machine. */
export function authDaemonLockPath(): string {
  return clientLocalPath('.auth-daemon.lock')
}

export async function readAuthDaemonLock(): Promise<AuthDaemonLock | null> {
  try {
    const raw = await fs.readFile(authDaemonLockPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const lock = parsed as Record<string, unknown>
    if (
      typeof lock.pid !== 'number'
      || typeof lock.baseUrl !== 'string'
      || typeof lock.startedAt !== 'number'
    ) return null
    return { pid: lock.pid, baseUrl: lock.baseUrl, startedAt: lock.startedAt }
  } catch {
    return null
  }
}

export async function writeAuthDaemonLock(lock: AuthDaemonLock): Promise<void> {
  await ensureClientLocalRoot()
  const p = authDaemonLockPath()
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(lock), { mode: 0o600 })
  await fs.rename(tmp, p)
}

export async function removeAuthDaemonLock(): Promise<void> {
  await fs.rm(authDaemonLockPath(), { force: true })
}

export function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** How to launch `yaac auth server run`. */
export interface AuthDaemonInvocation {
  bin: string
  args: string[]
}

/**
 * The command that relaunches this CLI as `yaac auth server run`: node plus
 * the bundled entry, or via tsx when running from source.
 */
function resolveAuthDaemonInvocation(): AuthDaemonInvocation {
  const entry = process.argv[1] ?? ''
  const cmd = ['auth', 'server', 'run']
  if (entry.endsWith('.ts')) {
    try {
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
      return { bin: process.execPath, args: [tsxCli, entry, ...cmd] }
    } catch {
      // tsx not installed
    }
  }
  return { bin: process.execPath, args: [entry, ...cmd] }
}

export interface SpawnAuthDaemonOptions {
  /** Defaults to relaunching this CLI; the desktop shell must override it. */
  invocation?: AuthDaemonInvocation
  /** Daemon env (e.g. a login-shell-hydrated PATH); defaults to process.env. */
  env?: NodeJS.ProcessEnv
  spawnImpl?: typeof spawn
}

export async function spawnAuthDaemonDetached(opts: SpawnAuthDaemonOptions = {}): Promise<void> {
  const { bin, args } = opts.invocation ?? resolveAuthDaemonInvocation()
  const child = (opts.spawnImpl ?? spawn)(bin, args, {
    detached: true,
    stdio: 'ignore',
    // eslint-disable-next-line no-process-env -- forward the full host env to the detached subprocess
    env: opts.env ?? process.env,
  })
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    setTimeout(resolve, 50)
  })
}

/** Is the main server currently seeing a connected auth agent? */
async function agentConnected(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/agent`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const body = await res.json() as { connected?: boolean }
    return body.connected === true
  } catch {
    return false
  }
}

export interface EnsureAuthDaemonSpawnedOptions extends SpawnAuthDaemonOptions {
  /**
   * Defaults to resolveServerTarget(). The desktop shell passes the server
   * its window is loading so both use the same one.
   */
  target?: ServerTarget
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
}

export interface EnsureAuthDaemonOptions extends EnsureAuthDaemonSpawnedOptions {
  /** Overrides the cold-boot budget; primarily useful for bounded callers and tests. */
  connectTimeoutMs?: number
  /** Overrides the connection poll interval. */
  pollIntervalMs?: number
}

/**
 * Ensure an auth server process for the current main server is running,
 * restarting one pointed at a different server. Does not wait for it to
 * connect, so the desktop app never blocks on it.
 */
export async function ensureAuthDaemonSpawned(
  opts: EnsureAuthDaemonSpawnedOptions = {},
): Promise<ServerTarget> {
  const target = opts.target ?? await resolveServerTarget()

  const lock = await readAuthDaemonLock()
  const live = lock !== null && isPidLive(lock.pid)
  if (live && lock.baseUrl !== target.baseUrl) {
    try {
      (opts.killImpl ?? process.kill)(lock.pid, 'SIGTERM')
    } catch { /* already gone */ }
    await removeAuthDaemonLock()
  }
  if (!live || lock?.baseUrl !== target.baseUrl) {
    await spawnAuthDaemonDetached(opts)
  }
  return { baseUrl: target.baseUrl }
}

/**
 * `ensureAuthDaemonSpawned` plus a bounded wait until the main server
 * reports the agent connected; throws so callers can fall back (e.g.
 * api-key entry).
 */
export async function ensureAuthDaemon(
  opts: EnsureAuthDaemonOptions = {},
): Promise<void> {
  const target = await ensureAuthDaemonSpawned(opts)

  // Generous because starting from source under tsx can be slow.
  const connectTimeoutMs = opts.connectTimeoutMs ?? AUTH_DAEMON_BOOT_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? 250
  const deadline = Date.now() + connectTimeoutMs
  while (Date.now() < deadline) {
    if (await agentConnected(target.baseUrl)) return
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  throw new Error(
    `The auth server did not connect within ${connectTimeoutMs / 1000}s. `
    + 'Check `yaac auth server status` on this machine.',
  )
}
