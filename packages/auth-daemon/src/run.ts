import { connectAuthAgent } from '#connection'
import { killAllToolLogins, setToolLoginPersistence } from '#tool-login'
import { killAllToolInstalls } from '#tool-install'
import {
  AUTH_DAEMON_BOOT_TIMEOUT_MS,
  authDaemonLockPath,
  isPidLive,
  readAuthDaemonLock,
  removeAuthDaemonLock,
  spawnAuthDaemonDetached,
  writeAuthDaemonLock,
} from '@yaac/shared/auth-daemon'
import { getApiClient, resolveServerTarget } from '@yaac/shared/server-api'
import { buildAuthPayload } from '@yaac/shared/tool-auth-interactive'
import { seedGitIdentityFromShell } from '@yaac/shared/git-identity-seed'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'

/**
 * `yaac auth server` lifecycle. The auth server only makes outbound
 * connections: it holds a pid lock, one WebSocket to the yaac server, and the
 * local vendor login/install subprocesses. Captured credentials are sent with
 * the authenticated `PUT /auth/:tool` call, never over the relay socket.
 */

function log(line: string): void {
  console.log(`[auth-daemon] ${line}`)
}

/** Entry point for `yaac auth server run` (foreground). */
export async function runAuthDaemon(): Promise<void> {
  const existing = await readAuthDaemonLock()
  if (existing && isPidLive(existing.pid)) {
    log(`already running pid=${existing.pid} (${existing.baseUrl})`)
    return
  }

  // No version check: when the desktop app spawns this daemon, its build id
  // may differ from the server's.
  const target = await resolveServerTarget()

  // Completed logins are saved on the (possibly remote) server.
  setToolLoginPersistence(async (tool, result) => {
    const client = getApiClient()
    await client.auth[':tool'].$put({
      param: { tool },
      json: buildAuthPayload(tool, result),
    })
  })

  // Seed the server's git identity from this machine's git config. The
  // desktop app starts the auth server, so webapp-only users get one too.
  // Never overwrites an existing identity, and failure is not fatal.
  try {
    const identity = await seedGitIdentityFromShell()
    if (identity) log(`git identity: ${identity.name} <${identity.email}>`)
  } catch (err) {
    log(`could not seed the git identity: ${err instanceof Error ? err.message : String(err)}`)
  }
  await reportDeviceTimeZone().catch((err: unknown) => {
    log(`could not report the time zone: ${err instanceof Error ? err.message : String(err)}`)
  })

  await writeAuthDaemonLock({ pid: process.pid, baseUrl: target.baseUrl, startedAt: Date.now() })
  log(`lock=${authDaemonLockPath()} target=${target.baseUrl}`)

  const connection = connectAuthAgent({ baseUrl: target.baseUrl, log })

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`)
    connection.stop()
    // Kill in-flight vendor CLIs so they don't outlive the daemon.
    killAllToolLogins()
    killAllToolInstalls()
    void removeAuthDaemonLock().finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  await new Promise<void>(() => { /* runs until signalled */ })
}

/** Entry point for `yaac auth server start` (spawn detached + wait). */
export async function startAuthDaemon(): Promise<void> {
  const existing = await readAuthDaemonLock()
  if (existing && isPidLive(existing.pid)) {
    console.error(`[yaac] auth server already running (pid ${existing.pid}, ${existing.baseUrl})`)
    return
  }
  await spawnAuthDaemonDetached()
  // The lock appears only after a full boot (a cold tsx transpile when run
  // from source) plus the server round-trip, about 6s or more under load.
  const startTimeoutMs = AUTH_DAEMON_BOOT_TIMEOUT_MS
  const deadline = Date.now() + startTimeoutMs
  while (Date.now() < deadline) {
    const lock = await readAuthDaemonLock()
    if (lock && isPidLive(lock.pid)) {
      console.error(`[yaac] auth server started (pid ${lock.pid}, ${lock.baseUrl})`)
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`auth server did not start within ${startTimeoutMs / 1000}s`)
}

/** Entry point for `yaac auth server stop`. */
export async function stopAuthDaemon(): Promise<void> {
  const lock = await readAuthDaemonLock()
  if (!lock || !isPidLive(lock.pid)) {
    await removeAuthDaemonLock()
    console.error('[yaac] auth server is not running')
    return
  }
  process.kill(lock.pid, 'SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isPidLive(lock.pid)) {
      console.error(`[yaac] auth server stopped (pid ${lock.pid})`)
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  await removeAuthDaemonLock()
  console.error(`[yaac] force-removed stale auth server lock (pid ${lock.pid})`)
}

/** Entry point for `yaac auth server status`. */
export async function statusAuthDaemon(): Promise<void> {
  const lock = await readAuthDaemonLock()
  if (!lock || !isPidLive(lock.pid)) {
    console.log('auth server: not running')
    return
  }
  console.log(`auth server: running (pid ${lock.pid})`)
  console.log(`target:      ${lock.baseUrl}`)
  // Only the server knows whether the daemon's socket is connected.
  try {
    const target = await resolveServerTarget()
    const res = await fetch(`${target.baseUrl}/api/auth/agent`, { signal: AbortSignal.timeout(3000) })
    const { connected } = await res.json() as { connected: boolean }
    console.log(`connected:   ${connected ? 'yes' : 'no'}`)
  } catch {
    console.log('connected:   unknown (server unreachable)')
  }
}
