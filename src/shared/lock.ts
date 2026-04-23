import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '@/shared/paths'

export interface DaemonLock {
  pid: number
  port: number
  secret: string
  startedAt: number
  buildId: string
}

export function daemonLockPath(): string {
  return path.join(getDataDir(), '.daemon.lock')
}

export async function readLock(): Promise<DaemonLock | null> {
  try {
    const raw = await fs.readFile(daemonLockPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isDaemonLock(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeLock(lock: DaemonLock): Promise<void> {
  const p = daemonLockPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  // Write to a temp file first, then rename so a reader never observes a
  // half-written lock. chmod 600 because the file contains a bearer secret.
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(lock), { mode: 0o600 })
  await fs.rename(tmp, p)
}

/**
 * Atomically acquire the daemon lock. POSIX `O_EXCL` guarantees only one
 * process wins the create, even when two `yaac daemon run` invocations race
 * past the pre-bind fast-path check in runDaemon and both try to take the
 * lock at the same moment.
 *
 * Returns `{ acquired: true }` when this process now owns the lock — the
 * file has been written with `lock`'s contents and mode 0600.
 *
 * Returns `{ acquired: false, existing }` when another live daemon holds
 * the lock. The caller is responsible for tearing down any resources it
 * allocated (e.g. a bound server) and exiting idempotently.
 *
 * A stale lock (dead pid, or `/health` unresponsive) is reclaimed: the
 * file is unlinked only if it still matches the stale lock we observed —
 * a pid+startedAt compare-and-delete — so a fresh lock that raced into
 * place between our read and unlink isn't clobbered. The create is then
 * retried.
 */
export async function acquireLock(
  lock: DaemonLock,
): Promise<{ acquired: true } | { acquired: false; existing: DaemonLock }> {
  const p = daemonLockPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  const payload = JSON.stringify(lock)
  const maxAttempts = 10
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const h = await fs.open(p, 'wx', 0o600)
      try {
        await h.writeFile(payload)
      } finally {
        await h.close()
      }
      return { acquired: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const existing = await readLock()
    if (existing && await isLockLive(existing)) {
      return { acquired: false, existing }
    }
    // Stale lock (or garbage mid-write). Compare-and-delete so we don't
    // clobber a fresh lock that landed between readLock() and unlink().
    // A null `existing` here means readLock() couldn't parse the file —
    // unlink unconditionally in that case so we can retry.
    try {
      const cur = await readLock()
      const stillStale = !existing || !cur
        || (cur.pid === existing.pid && cur.startedAt === existing.startedAt)
      if (stillStale) {
        await fs.unlink(p)
      }
    } catch {
      // already gone — retry
    }
  }
  throw new Error('failed to acquire daemon lock after retries')
}

/**
 * Remove the daemon lock file.
 *
 * With `expectedPid`, only unlink when the on-disk lock still names that
 * pid. This guards against a zombified shutdown (e.g. a previous daemon
 * that hung past `stopDaemon`'s 3s force-remove timeout) clobbering a
 * successor daemon's lock when it eventually unblocks.
 *
 * Without `expectedPid`, unlink unconditionally — appropriate for callers
 * that have already classified the lock as stale (dead pid / unresponsive
 * /health) and simply need to clear the file before a fresh spawn.
 */
export async function removeLock(expectedPid?: number): Promise<void> {
  if (expectedPid !== undefined) {
    const cur = await readLock()
    if (!cur || cur.pid !== expectedPid) return
  }
  try {
    await fs.unlink(daemonLockPath())
  } catch {
    // already gone
  }
}

/**
 * A lock is "live" if (a) the pid still exists and (b) /health answers
 * within 500ms. Used both by the CLI (is there a daemon to talk to?) and
 * by a second `yaac daemon` invocation (should I exit idempotently?).
 */
export async function isLockLive(lock: DaemonLock): Promise<boolean> {
  if (!pidExists(lock.pid)) return false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 500)
    try {
      const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
        headers: { authorization: `Bearer ${lock.secret}` },
        signal: ctl.signal,
      })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal it — still alive.
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function isDaemonLock(value: unknown): value is DaemonLock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === 'number'
    && typeof v.port === 'number'
    && typeof v.secret === 'string'
    && typeof v.startedAt === 'number'
    && typeof v.buildId === 'string'
  )
}
