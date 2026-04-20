import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { buildApp } from '@/lib/daemon/server'
import { readBuildId } from '@/lib/build-id'
import {
  daemonLockPath,
  isLockLive,
  readLock,
  removeLock,
  writeLock,
  type DaemonLock,
} from '@/lib/daemon/lock'
import { ensureDataDir } from '@/lib/project/paths'
import { startBackgroundLoop } from '@/lib/daemon/background-loop'

const __filename = fileURLToPath(import.meta.url)

export interface DaemonRunOptions {
  port?: number
}

/**
 * Entry point for `yaac daemon run` — the foreground HTTP server.
 *
 * - If another daemon is already live, print its handshake and exit 0
 *   (idempotent).
 * - Otherwise bind 127.0.0.1:<port-or-ephemeral>, write the lock, serve
 *   until SIGTERM / SIGINT, then unlink the lock and exit.
 */
export async function runDaemon(opts: DaemonRunOptions): Promise<void> {
  await ensureDataDir()

  // Read build-id up front so a broken install fails loudly before we
  // bind a port or write a lock file.
  const buildId = await readBuildId()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    console.error(`[daemon] already running pid=${existing.pid} port=${existing.port}`)
    return
  }

  const secret = crypto.randomBytes(32).toString('hex')
  const app = buildApp({ secret, buildId })

  const { server, port } = await new Promise<{ server: ServerType; port: number }>(
    (resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: '127.0.0.1' }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    },
  )

  await writeLock({ pid: process.pid, port, secret, startedAt: Date.now(), buildId })
  console.error(`[daemon] listening on 127.0.0.1:${port} lock=${daemonLockPath()}`)

  const abortCtrl = new AbortController()
  const loopDone = startBackgroundLoop({ signal: abortCtrl.signal })

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[daemon] ${signal} — shutting down`)
    abortCtrl.abort()
    try {
      await loopDone
    } catch (err) {
      console.error('[daemon] loop exit error:', err)
    }
    // @hono/node-server wraps a Node http.Server; close() refuses new
    // connections, drains in-flight requests, then fires the callback.
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

/**
 * Entry point for `yaac daemon start`.
 *
 * - If a daemon is already running with the matching buildId, no-op.
 * - If running with a different buildId, throw — the user should
 *   `yaac daemon restart`.
 * - Otherwise clean any stale lock, spawn `yaac daemon run` detached,
 *   and wait up to 5s for the new lock to appear.
 */
export async function startDaemon(): Promise<void> {
  await ensureDataDir()
  const cliBuildId = await readBuildId()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    if (existing.buildId === cliBuildId) {
      console.error(`[yaac] daemon already running pid=${existing.pid} port=${existing.port}`)
      return
    }
    throw new Error(
      'yaac daemon is running an outdated version '
      + `(daemon buildId ${existing.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac daemon restart',
    )
  }

  // Lock file present but not live (pid dead or /health unresponsive) —
  // the next spawn's idempotency check would overwrite it anyway, but
  // clearing first keeps the "wait for new lock" poll simple.
  if (existing) await removeLock()

  await spawnDaemonDetached()
  const fresh = await waitForLiveLock(5000)
  if (fresh.buildId !== cliBuildId) {
    throw new Error(
      `daemon buildId ${fresh.buildId} does not match CLI buildId ${cliBuildId}`,
    )
  }
  console.error(`[yaac] daemon started pid=${fresh.pid} port=${fresh.port}`)
}

/**
 * Entry point for `yaac daemon stop`. SIGTERMs the running daemon and
 * waits for its shutdown handler to unlink the lock. Force-removes the
 * lock if the daemon doesn't exit within 3s.
 */
export async function stopDaemon(): Promise<void> {
  const existing = await readLock()
  if (!existing) {
    console.error('[yaac] daemon is not running')
    return
  }
  if (!await isLockLive(existing)) {
    await removeLock()
    console.error(`[yaac] removed stale lock (pid ${existing.pid})`)
    return
  }

  try {
    process.kill(existing.pid, 'SIGTERM')
  } catch {
    // Process already gone — still need to clear the lock below.
  }

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== existing.pid) {
      console.error(`[yaac] daemon stopped (pid ${existing.pid})`)
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  // Daemon didn't clean up in time. Remove the lock ourselves — the old
  // process is either gone or wedged, either way it's no longer the
  // source of truth.
  const cur = await readLock()
  if (cur && cur.pid === existing.pid) await removeLock()
  console.error(`[yaac] force-removed stale lock (pid ${existing.pid})`)
}

/**
 * Entry point for `yaac daemon restart`. Stops any running daemon, then
 * starts a fresh one.
 */
export async function restartDaemon(): Promise<void> {
  await stopDaemon()
  await startDaemon()
}

async function spawnDaemonDetached(): Promise<void> {
  const { bin, args } = resolveDaemonInvocation()
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  // If the spawn itself fails immediately (e.g. ENOENT), surface it.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    // A spawned detached process won't emit a useful signal here, so
    // give it a tick and assume success — the lock poll will catch
    // the actual failure mode (e.g. "daemon never wrote the lock").
    setTimeout(resolve, 50)
  })
}

/**
 * Figure out how to relaunch ourselves as `yaac daemon run`.
 *
 * - Production build (`dist/cli.js`): `process.execPath` is node and
 *   `argv[1]` is the bundled entry — just reuse both.
 * - Dev (source `.ts` files): we're running under tsx. tsx strips its
 *   own CLI script from argv before running the target, so `argv[1]`
 *   is the source entry (`src/cli.ts`). Respawn via tsx's CLI so the
 *   loader is set up again in the child.
 */
function resolveDaemonInvocation(): { bin: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  if (entry.endsWith('.ts')) {
    const tsxCli = findTsxCli()
    if (tsxCli) return { bin: process.execPath, args: [tsxCli, entry, 'daemon', 'run'] }
    // Fallback: launch via node and hope NODE_OPTIONS carries the loader.
    return { bin: process.execPath, args: [entry, 'daemon', 'run'] }
  }
  return { bin: process.execPath, args: [entry, 'daemon', 'run'] }
}

function findTsxCli(): string | null {
  const here = path.dirname(__filename)
  // Walk up from src/commands/ looking for node_modules/tsx/dist/cli.mjs (or
  // the pnpm-flattened equivalent).
  let dir = here
  for (let i = 0; i < 10; i++) {
    const direct = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (existsSync(direct)) return direct
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function waitForLiveLock(timeoutMs: number): Promise<DaemonLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock && await isLockLive(lock)) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('daemon did not start within 5s')
}
