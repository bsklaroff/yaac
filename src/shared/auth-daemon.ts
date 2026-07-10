import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { getDataDir } from '@/shared/paths'
import { resolveDaemonTarget } from '@/shared/daemon-client'

/**
 * Client-side lifecycle of the auth daemon — the login broker that runs
 * on the user's machine, connects outbound to the (possibly remote) main
 * daemon, and executes claude/codex sign-in flows locally where the
 * browser and the vendors' localhost OAuth callbacks live.
 *
 * Lives in shared (not src/auth-daemon) because commands may only import
 * from shared: `yaac auth update` and `yaac open` call ensureAuthDaemon().
 */

export interface AuthDaemonLock {
  pid: number
  /** The main-daemon origin this agent connected to. */
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

/**
 * Relaunch ourselves as `yaac auth daemon run`, detached. Mirrors the
 * main daemon's self-invocation: production reuses node + the bundled
 * entry; dev respawns via tsx so the loader is set up in the child.
 */
function resolveAuthDaemonInvocation(): { bin: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  const cmd = ['auth', 'daemon', 'run']
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

export async function spawnAuthDaemonDetached(): Promise<void> {
  const { bin, args } = resolveAuthDaemonInvocation()
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    // eslint-disable-next-line no-process-env -- forward the full host env to the detached subprocess
    env: process.env,
  })
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    setTimeout(resolve, 50)
  })
}

/** Is the main daemon currently seeing a connected auth agent? */
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

/**
 * Make sure an auth daemon process for the currently resolved main
 * daemon exists on this machine, restarting one pointed at a different
 * daemon (the remote setting changed since it started). Does not wait
 * for the agent to connect — `yaac open` uses this fire-and-mostly-
 * forget variant so opening the webapp never blocks on the broker.
 */
export async function ensureAuthDaemonSpawned(): Promise<{ baseUrl: string; secret: string }> {
  const target = await resolveDaemonTarget()

  const lock = await readAuthDaemonLock()
  const live = lock !== null && isPidLive(lock.pid)
  if (live && lock.baseUrl !== target.baseUrl) {
    // Pointed at the wrong daemon — restart against the current target.
    try {
      process.kill(lock.pid, 'SIGTERM')
    } catch { /* already gone */ }
    await removeAuthDaemonLock()
  }
  if (!live || lock?.baseUrl !== target.baseUrl) {
    await spawnAuthDaemonDetached()
  }
  return { baseUrl: target.baseUrl, secret: target.secret }
}

/**
 * `ensureAuthDaemonSpawned` plus a bounded wait until the main daemon
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
    'The auth daemon did not connect within 8s. '
    + 'Check `yaac auth daemon status` on this machine.',
  )
}
