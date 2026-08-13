import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readBuildId } from '@yaac/shared/build-id'
import { readLock, removeLock } from '@yaac/shared/lock'
import { isLockLive, isLockReady, type ServerLock } from '@yaac/shared/server-lock-file'
import { ensureDataDir } from '@yaac/shared/project-paths'
import { serverLogPath } from '@yaac/shared/paths'
import { preflightHostTor } from '#main/server-run'
import { env } from '@yaac/shared/env'
import { assertDriverSwitchSafe } from '#main/driver-choice'

/**
 * Entry point for `yaac server start`.
 *
 * - If a server is already running with the matching buildId, no-op.
 * - If running with a different buildId, throw — the user should
 *   `yaac server restart`.
 * - Otherwise clean any stale lock, spawn `yaac server run` detached,
 *   and wait up to 5s for the new lock to appear.
 */
export async function startServer(): Promise<void> {
  await preflightHostTor()
  await ensureDataDir()
  // Before the spawn, so a refusal reaches the operator directly: the
  // detached child dies before its log exists, and they would otherwise
  // wait out the ready poll for a timeout that explains nothing.
  await assertDriverSwitchSafe()
  const cliBuildId = await readBuildId()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    if (existing.buildId === cliBuildId) {
      console.error(`[yaac] server already running pid=${existing.pid} port=${existing.port}`)
      return
    }
    throw new Error(
      'yaac server is running an outdated version '
      + `(server buildId ${existing.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac server restart',
    )
  }

  // Lock file present but not live (pid dead or /health unresponsive) —
  // the next spawn's idempotency check would overwrite it anyway, but
  // clearing first keeps the "wait for new lock" poll simple.
  if (existing) await removeLock()

  await spawnServerDetached()
  // Wait for readiness, not bare liveness: the server writes its lock and
  // answers /health before it opens the DB and runs first-boot migrations,
  // which block the event loop for seconds. Returning on the pre-init
  // /health would print "server started" while the next command's liveness
  // probe times out against the frozen loop. 30s comfortably covers a
  // cold-start migration (a few seconds) plus headroom on a loaded host.
  const fresh = await waitForReadyLock(30_000)
  if (fresh.buildId !== cliBuildId) {
    throw new Error(
      `server buildId ${fresh.buildId} does not match CLI buildId ${cliBuildId}`,
    )
  }
  const torPrefix = env.useTor ? '(using tor) ' : ''
  console.error(`[yaac] ${torPrefix}server started pid=${fresh.pid} port=${fresh.port}`)
}

/**
 * Entry point for `yaac server stop`. SIGTERMs the running server and
 * waits for its shutdown handler to unlink the lock. Force-removes the
 * lock if the server doesn't exit within 3s.
 */
export async function stopServer(): Promise<void> {
  const existing = await readLock()
  if (!existing) {
    console.error('[yaac] server is not running')
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

  // The server's shutdown path is bounded to ~6s worst case (3s loop
  // drain + 3s server close) under heavy parallel load. Poll with
  // headroom so a healthy SIGTERM-driven exit isn't misreported as a
  // "force-removed stale lock".
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== existing.pid) {
      console.error(`[yaac] server stopped (pid ${existing.pid})`)
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  // Server didn't clean up in time. Remove the lock ourselves — the old
  // process is either gone or wedged, either way it's no longer the
  // source of truth.
  const cur = await readLock()
  if (cur && cur.pid === existing.pid) await removeLock()
  console.error(`[yaac] force-removed stale lock (pid ${existing.pid})`)
}

/**
 * Entry point for `yaac server restart`. Stops any running server, then
 * starts a fresh one.
 */
export async function restartServer(): Promise<void> {
  await stopServer()
  await startServer()
}

async function spawnServerDetached(): Promise<void> {
  const { bin, args } = resolveServerInvocation()
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    // eslint-disable-next-line no-process-env -- forward the full host env to the detached server subprocess
    env: process.env,
  })
  child.unref()
  // If the spawn itself fails immediately (e.g. ENOENT), surface it.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    // A spawned detached process won't emit a useful signal here, so
    // give it a tick and assume success — the lock poll will catch
    // the actual failure mode (e.g. "server never wrote the lock").
    setTimeout(resolve, 50)
  })
}

/**
 * Figure out how to relaunch ourselves as `yaac server run`.
 *
 * - Production build (`dist/cli.js`): `process.execPath` is node and
 *   `argv[1]` is the bundled entry — just reuse both.
 * - Dev (source `.ts` files): we're running under tsx. tsx strips its
 *   own CLI script from argv before running the target, so `argv[1]`
 *   is the source entry (`src/cli.ts`). Respawn via tsx's CLI so the
 *   loader is set up again in the child.
 */
function resolveServerInvocation(): { bin: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  if (entry.endsWith('.ts')) {
    const tsxCli = findTsxCli()
    if (tsxCli) return { bin: process.execPath, args: [tsxCli, entry, 'server', 'run'] }
    // Fallback: launch via node and hope NODE_OPTIONS carries the loader.
    return { bin: process.execPath, args: [entry, 'server', 'run'] }
  }
  return { bin: process.execPath, args: [entry, 'server', 'run'] }
}

function findTsxCli(): string | null {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli')
  } catch {
    return null // tsx not installed (production build) — caller falls back
  }
}

async function waitForReadyLock(timeoutMs: number): Promise<ServerLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock && await isLockReady(lock)) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server did not become ready within ${Math.round(timeoutMs / 1000)}s`)
}

export interface ServerLogsOptions {
  /** Keep printing as new lines are appended to the log file. */
  follow?: boolean
  /** Print only the last N lines (before following, if combined with follow). */
  lines?: number
}

/**
 * Entry point for `yaac server logs`. Prints ~/.yaac/server.log to stdout
 * by spawning stock `tail` (flags limited to those shared by BSD and GNU
 * tail — macOS and Linux are the only supported platforms).
 *
 * - No options: prints the whole file (`tail -n +1`).
 * - `--lines N`: prints only the last N lines (`tail -n N`).
 * - `--follow`: keeps printing as content is appended (`tail -F`, which
 *   also handles the file appearing later and truncation/replacement).
 */
export async function serverLogs(opts: ServerLogsOptions = {}): Promise<void> {
  const logPath = serverLogPath()

  if (!existsSync(logPath)) {
    if (!opts.follow) {
      console.error(`[yaac] no server log at ${logPath}`)
      return
    }
    console.error(`[yaac] no server log at ${logPath} yet — waiting for it`)
  }

  const args = opts.follow ? ['-F'] : []
  // `-n +1` = from the first line (whole file); `-n N` = last N lines.
  // Negative N would flip tail into last-|N|-lines mode — clamp to 0,
  // matching the old "print nothing" behavior.
  args.push('-n', opts.lines !== undefined ? String(Math.max(0, opts.lines)) : '+1')
  args.push(logPath)

  // stderr is dropped: the missing-file case is reported above, and in
  // follow mode `tail -F` narrates retries/rotation we don't want shown.
  const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.pipe(process.stdout, { end: false })

  await new Promise<void>((resolve, reject) => {
    // Forward Ctrl-C so tail dies with us instead of being orphaned.
    const onSigint = (): void => { child.kill('SIGINT') }
    process.on('SIGINT', onSigint)
    child.on('error', (err) => {
      process.off('SIGINT', onSigint)
      reject(err)
    })
    child.on('close', (code, signal) => {
      process.off('SIGINT', onSigint)
      if (code === 0 || signal === 'SIGINT') resolve()
      else reject(new Error(`tail exited with ${signal ?? `code ${code}`}`))
    })
  })
}
