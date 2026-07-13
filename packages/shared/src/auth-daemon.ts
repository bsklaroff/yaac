import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { getDataDir } from '#paths'
import { resolveServerTarget, type ServerTarget } from '#server-client'

/**
 * Client-side lifecycle of the auth server — the login broker that runs
 * on the user's machine, connects outbound to the (possibly remote) main
 * server, and executes claude/codex sign-in flows locally where the
 * browser and the vendors' localhost OAuth callbacks live.
 *
 * Lives in shared (not src/auth-daemon) because commands may only import
 * from shared: `yaac auth update` and `yaac open` call ensureAuthDaemon().
 * The desktop shell is the second caller class: it can't use the CLI
 * self-invocation or the default target resolution (an Electron process
 * has neither a yaac argv[1] nor a build id), so both are overridable.
 */

export interface AuthDaemonLock {
  pid: number
  /** The main-server origin this agent connected to. */
  baseUrl: string
  startedAt: number
}

export function authDaemonLockPath(): string {
  return path.join(getDataDir(), '.auth-daemon.lock')
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
  await fs.mkdir(getDataDir(), { recursive: true })
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
 * Relaunch ourselves as `yaac auth server run`, detached. Mirrors the
 * main server's self-invocation: production reuses node + the bundled
 * entry; dev respawns via tsx so the loader is set up in the child.
 */
function resolveAuthDaemonInvocation(): AuthDaemonInvocation {
  const entry = process.argv[1] ?? ''
  const cmd = ['auth', 'server', 'run']
  if (entry.endsWith('.ts')) {
    try {
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
      return { bin: process.execPath, args: [tsxCli, entry, ...cmd] }
    } catch {
      // tsx not installed (production build) — fall through
    }
  }
  return { bin: process.execPath, args: [entry, ...cmd] }
}

export interface SpawnAuthDaemonOptions {
  /**
   * Defaults to relaunching this process (CLI self-invocation) — callers
   * whose process is not the yaac CLI (the desktop shell) must override.
   */
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
async function agentConnected(baseUrl: string, secret: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/auth/agent`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const body = await res.json() as { connected?: boolean }
    return body.connected === true
  } catch {
    return false
  }
}

export interface EnsureAuthDaemonSpawnedOptions extends SpawnAuthDaemonOptions {
  /**
   * Pre-resolved target; defaults to resolveServerTarget(). Pure clients
   * (the desktop shell) must pass their requireBuildMatch:false target —
   * the default resolve would readBuildId() and throw in their process.
   */
  target?: ServerTarget
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Make sure an auth server process for the currently resolved main
 * server exists on this machine, restarting one pointed at a different
 * server (the remote setting changed since it started). Does not wait
 * for the agent to connect — `yaac open` uses this fire-and-mostly-
 * forget variant so opening the webapp never blocks on the broker.
 */
export async function ensureAuthDaemonSpawned(
  opts: EnsureAuthDaemonSpawnedOptions = {},
): Promise<{ baseUrl: string; secret: string }> {
  const target = opts.target ?? await resolveServerTarget()

  const lock = await readAuthDaemonLock()
  const live = lock !== null && isPidLive(lock.pid)
  if (live && lock.baseUrl !== target.baseUrl) {
    // Pointed at the wrong server — restart against the current target.
    try {
      (opts.killImpl ?? process.kill)(lock.pid, 'SIGTERM')
    } catch { /* already gone */ }
    await removeAuthDaemonLock()
  }
  if (!live || lock?.baseUrl !== target.baseUrl) {
    await spawnAuthDaemonDetached(opts)
  }
  return { baseUrl: target.baseUrl, secret: target.secret }
}

/**
 * `ensureAuthDaemonSpawned` plus a bounded wait until the main server
 * reports the agent connected; throws so callers can fall back (e.g.
 * api-key entry).
 */
export async function ensureAuthDaemon(): Promise<void> {
  const target = await ensureAuthDaemonSpawned()

  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await agentConnected(target.baseUrl, target.secret)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    'The auth server did not connect within 8s. '
    + 'Check `yaac auth server status` on this machine.',
  )
}
