import { connectAuthAgent } from '#connection'
import { killAllToolLogins, setToolLoginPersistence } from '#tool-login'
import { killAllToolInstalls } from '#tool-install'
import {
  authDaemonLockPath,
  isPidLive,
  readAuthDaemonLock,
  removeAuthDaemonLock,
  spawnAuthDaemonDetached,
  writeAuthDaemonLock,
} from '@yaac/shared/auth-daemon'
import { getApiClient, resolveServerTarget } from '@yaac/shared/server-api'
import { buildAuthPayload } from '@yaac/shared/tool-auth-interactive'
import { maskToken } from '@yaac/shared/mask'

/**
 * `yaac auth server` lifecycle. The auth server is a pure outbound
 * client: no listening socket, just a pid lock, one WebSocket to the
 * main server, and the local vendor login/install subprocesses. Its one
 * write path is `PUT /auth/:tool` — captured credentials always travel
 * over the authenticated RPC channel, never through the relay socket.
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

  // Pure client: the broker repairs nothing on a version mismatch and only
  // needs the server to be live — and when the desktop .app spawns us, our
  // build id may legitimately differ from the running server's.
  const target = await resolveServerTarget({ requireBuildMatch: false })

  // Completed logins land on the (possibly remote) main server, not on
  // this machine's data dir.
  setToolLoginPersistence(async (tool, result) => {
    const client = getApiClient()
    await client.auth[':tool'].$put({
      param: { tool },
      json: buildAuthPayload(tool, result),
    })
  })

  await writeAuthDaemonLock({ pid: process.pid, baseUrl: target.baseUrl, startedAt: Date.now() })
  log(`lock=${authDaemonLockPath()} target=${target.baseUrl} token=${maskToken(target.secret)}`)

  const connection = connectAuthAgent({ baseUrl: target.baseUrl, secret: target.secret, log })

  const shutdown = (signal: string): void => {
    log(`${signal} — shutting down`)
    connection.stop()
    // Kill any in-flight vendor CLIs so they don't outlive the broker.
    killAllToolLogins()
    killAllToolInstalls()
    void removeAuthDaemonLock().finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Keep the process alive: the WebSocket and timers do the work.
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
  // The daemon writes its lock only after a full process boot (from source, a
  // cold tsx transpile of the dependency tree) plus the `resolveServerTarget()`
  // round-trip — ~6s from spawn on an idle machine, and more under load. The
  // old 5s budget sat under that, so this reported failure while a perfectly
  // healthy daemon was still starting: the lock landed ~1s AFTER the throw,
  // leaving a running auth server behind a nonzero exit. Waiting longer is
  // free in the success path (the loop returns the moment the lock appears);
  // it only delays reporting a daemon that genuinely never starts.
  const startTimeoutMs = 30_000
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
  // The authoritative "connected" signal lives on the main server.
  try {
    const target = await resolveServerTarget()
    const res = await fetch(`${target.baseUrl}/auth/agent`, {
      headers: { authorization: `Bearer ${target.secret}` },
      signal: AbortSignal.timeout(3000),
    })
    const { connected } = await res.json() as { connected: boolean }
    console.log(`connected:   ${connected ? 'yes' : 'no'}`)
  } catch {
    console.log('connected:   unknown (server unreachable)')
  }
}
