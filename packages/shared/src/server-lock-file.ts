/**
 * The pure half of the server-lock contract: the lock's shape and liveness
 * semantics, with no file I/O. `#lock` owns reading and writing the file at
 * serverLocalRoot().
 */

import os from 'node:os'
import { env } from '#env'

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
   * The pod name of a server running in the cluster, absent for a host
   * process. Tells a reader whether `pid` and the loopback `/health` probe
   * apply to it ({@link isLocalLock}).
   */
  pod?: string
  /**
   * `os.hostname()` of the writer. Written only for an older yaac, which
   * cannot parse a lock without it and decides by it how to check the lock;
   * nothing here reads it (docs/legacy-compat-shims.md).
   */
  host?: string
  /**
   * Last lease renewal, ms epoch, rewritten every
   * {@link LEASE_HEARTBEAT_MS}. A reader across the pod boundary treats the
   * lock as held while this is younger than {@link LEASE_STALE_MS}.
   */
  heartbeatAt: number
}

export const SERVER_LOCK_FILENAME = '.server.lock'

/** How often the running server renews `heartbeatAt`. */
export const LEASE_HEARTBEAT_MS = 5_000
/**
 * How old a heartbeat may get before a reader across the pod boundary may
 * take the lock. Four missed renewals: long enough that a GC pause cannot
 * let a second server open the same database, short enough that a killed
 * pod's replacement starts promptly.
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
    && (v.pod === undefined || typeof v.pod === 'string')
    && typeof v.heartbeatAt === 'number'
  )
}

/**
 * Whether the lock's writer shares this reader's pid namespace and
 * loopback, so `process.kill(pid, 0)` and a `127.0.0.1:<port>` probe
 * apply: a host lock read on the host, or a pod's lock read in that same
 * pod (restarted in place). False when a host reads a pod's lock, or a pod
 * reads a host's or another pod's. The machine's hostname never matters.
 * A reader in another pid namespace than a host server (a second machine
 * sharing the data dir, or a container it is mounted into) also takes its
 * lock as local, which is why {@link isLockLive} never lets a dead pid
 * outweigh a fresh lease.
 */
export function isLocalLock(lock: ServerLock): boolean {
  return lock.pod === undefined ? !env.inCluster : lock.pod === os.hostname()
}

/** Whether the lease is still being renewed (the cross-boundary liveness check). */
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
 * A lock is live while its lease is fresh, or while its server answers
 * here: a {@link isLocalLock} lock whose pid is another running process and
 * whose port answers HTTP within 500ms. Any response counts, even a 404: an
 * old server without `/api/health` still holds the database and must be
 * stopped, not reclaimed.
 *
 * A dead pid does not free a lock whose lease is fresh, since a reader in
 * another pid namespace sees a live server's pid as dead. So a server that
 * died without removing its lock holds it until the lease lapses. The
 * exception is a lock naming this pod and our own pid: the pod restarted in
 * place ({@link isOtherLivePid}), so its predecessor is gone. A host lock
 * naming our own pid gets no such shortcut, since two containers that both
 * start `yaac server run` as pid 1 would each take the other's for their
 * own.
 */
export async function isLockLive(lock: ServerLock): Promise<boolean> {
  if (lock.pod === os.hostname() && lock.pid === process.pid) return false
  if (isLeaseFresh(lock)) return true
  if (!isLocalLock(lock) || !isOtherLivePid(lock.pid)) return false
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
 * stale. Across the pod boundary only the lease can be checked.
 */
export async function isLockReady(lock: ServerLock): Promise<boolean> {
  if (!isLocalLock(lock)) return isLeaseFresh(lock)
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
 * own pid is stale: a container restarted in place keeps its pod name and
 * reuses the pid (its entrypoint forks the same way on every start), so the
 * lock left by the killed server would otherwise read as live and the new
 * one would exit.
 */
export function isOtherLivePid(pid: number): boolean {
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
