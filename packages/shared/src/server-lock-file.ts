/**
 * The pure half of the server-lock contract: the lock's shape and liveness
 * semantics, with no file I/O. `#lock` owns reading and writing the file at
 * serverLocalRoot().
 */

import os from 'node:os'

export interface ServerLock {
  pid: number
  port: number
  startedAt: number
  buildId: string
  /**
   * Random id of the server process, minted per boot, used for
   * compare-and-delete. `pid` cannot serve: two server pods can both be
   * pid 1.
   */
  instance: string
  /**
   * `os.hostname()` of the writer (the pod name in the cluster). Tells a
   * reader whether `pid` and the loopback `/health` probe apply to it.
   */
  host: string
  /**
   * Last lease renewal, ms epoch, rewritten every
   * {@link LEASE_HEARTBEAT_MS}. A reader on another host treats the lock as
   * held while this is younger than {@link LEASE_STALE_MS}.
   */
  heartbeatAt: number
}

export const SERVER_LOCK_FILENAME = '.server.lock'

/** How often the running server renews `heartbeatAt`. */
export const LEASE_HEARTBEAT_MS = 5_000
/**
 * How old a heartbeat may get before another host may take the lock. Four
 * missed renewals: long enough that a GC pause cannot let a second server
 * open the same database, short enough that a killed pod's replacement
 * starts promptly.
 */
export const LEASE_STALE_MS = 20_000

export function isServerLock(value: unknown): value is ServerLock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === 'number'
    && typeof v.port === 'number'
    && typeof v.startedAt === 'number'
    && typeof v.buildId === 'string'
    && typeof v.instance === 'string'
    && typeof v.host === 'string'
    && typeof v.heartbeatAt === 'number'
  )
}

/**
 * Whether the lock's writer shares this reader's pid namespace and
 * loopback, so `process.kill(pid, 0)` and a `127.0.0.1:<port>` probe
 * apply. False when a host reads an in-cluster server's lock or vice versa.
 */
export function isSameHostLock(lock: ServerLock): boolean {
  return lock.host === os.hostname()
}

/** Whether the lease is still being renewed (the cross-host liveness check). */
export function isLeaseFresh(lock: ServerLock): boolean {
  return Date.now() - lock.heartbeatAt < LEASE_STALE_MS
}

/** Parse raw lock-file contents; null for malformed JSON or a wrong shape. */
export function parseServerLock(raw: string): ServerLock | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return isServerLock(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A lock is live if its pid is another running process and its port
 * answers HTTP within 500ms. Any response counts, even a 404: an old server
 * without `/api/health` still holds the database and must be stopped, not
 * reclaimed. A lock from another host is judged by its lease instead.
 */
export async function isLockLive(lock: ServerLock): Promise<boolean> {
  if (!isSameHostLock(lock)) return isLeaseFresh(lock)
  if (!isOtherLivePid(lock.pid)) return false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 500)
    try {
      await fetch(`http://127.0.0.1:${lock.port}/api/health`, { signal: ctl.signal })
      return true
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * A lock is ready when the server has also finished startup (DB open and
 * migrations). `yaac server start` waits on this because the lock is
 * written before startup, which blocks the event loop. Lock reclamation
 * uses {@link isLockLive} instead, so a starting server is not treated as
 * stale. From another host only the lease can be checked.
 */
export async function isLockReady(lock: ServerLock): Promise<boolean> {
  if (!isSameHostLock(lock)) return isLeaseFresh(lock)
  if (!isOtherLivePid(lock.pid)) return false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 500)
    try {
      const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, { signal: ctl.signal })
      if (!res.ok) return false
      const body = await res.json() as { ready?: unknown }
      return body.ready === true
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * Whether `pid` is a running process other than this one. A lock naming our
 * own pid is stale: a container restarted in place keeps its hostname and
 * reuses the pid (its entrypoint forks the same way on every start), so the
 * lock left by the killed server would otherwise read as live and the new
 * one would exit.
 */
function isOtherLivePid(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but we may not signal it.
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}
