/**
 * The dependency-free half of the server-lock contract: the lock's shape and
 * liveness semantics, with no `#…` or `@yaac/*` imports. Split out of
 * `#lock` (which owns the file I/O rooted at getDataDir()) so that
 * `packages/frontend/vite.config.ts` — loaded through esbuild, which can resolve
 * neither bare `@yaac/*` specifiers nor package `imports` maps at
 * config-load time — can share the exact same parsing and liveness rules via
 * a relative import instead of hand-rolling them.
 */

import os from 'node:os'

export interface ServerLock {
  pid: number
  port: number
  secret: string
  startedAt: number
  buildId: string
  /**
   * Identity of the server process holding the lock, minted per boot. What
   * `pid` used to mean for compare-and-delete: pids are per-namespace, so
   * once a server can be a pod, two servers of the same install genuinely
   * can both be pid 1.
   *
   * Optional because a lock written before the lease existed has none —
   * see docs/legacy-compat-shims.md.
   */
  instance?: string
  /**
   * `os.hostname()` of the writer: the machine for a host process, the pod
   * name for the in-cluster server. Not decoration — it is what says
   * whether the pid and the loopback `/health` probe below MEAN anything to
   * this reader. Absent = written before the lease, and read as this host
   * (which is what it was).
   */
  host?: string
  /**
   * Last renewal of the lease, ms epoch. The running server rewrites it
   * every {@link LEASE_HEARTBEAT_MS}; a reader that cannot use pid liveness
   * treats the lock as held while this is younger than
   * {@link LEASE_STALE_MS}.
   */
  heartbeatAt?: number
}

export const SERVER_LOCK_FILENAME = '.server.lock'

/** How often the running server renews `heartbeatAt`. */
export const LEASE_HEARTBEAT_MS = 5_000
/**
 * How old a heartbeat may get before a lock is takeable. Four missed
 * renewals: long enough that a GC pause or a loaded node cannot hand the
 * install a second writer of the same PGlite database, short enough that a
 * SIGKILLed pod's replacement is not held out for a visible age. Where pid
 * liveness applies (same host) it still answers instantly and this bound is
 * never reached.
 */
export const LEASE_STALE_MS = 20_000

export function isServerLock(value: unknown): value is ServerLock {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.pid === 'number'
    && typeof v.port === 'number'
    && typeof v.secret === 'string'
    && typeof v.startedAt === 'number'
    && typeof v.buildId === 'string'
    && (v.instance === undefined || typeof v.instance === 'string')
    && (v.host === undefined || typeof v.host === 'string')
    && (v.heartbeatAt === undefined || typeof v.heartbeatAt === 'number')
  )
}

/**
 * Whether this reader shares a pid namespace and a loopback with the lock's
 * writer, and may therefore judge it by `process.kill(pid, 0)` and a
 * `127.0.0.1:<port>` probe. False for an in-cluster server's lock read from
 * the host (and vice versa), where both signals answer about the wrong
 * process on the wrong interface.
 */
export function isSameHostLock(lock: ServerLock): boolean {
  return lock.host === undefined || lock.host === os.hostname()
}

/** Whether the lease is still being renewed — the cross-host liveness signal. */
export function isLeaseFresh(lock: ServerLock): boolean {
  if (lock.heartbeatAt === undefined) return false
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
 * A lock is "live" if (a) the pid still exists and (b) /health answers
 * within 500ms. Used both by the CLI (is there a server to talk to?) and
 * by a second `yaac server` invocation (should I exit idempotently?).
 *
 * Both signals are local ones, so a lock written on the other side of a
 * container boundary is judged by its lease instead (see
 * {@link isSameHostLock}): its pid names a process in another namespace and
 * its port is on another loopback.
 */
export async function isLockLive(lock: ServerLock): Promise<boolean> {
  if (!isSameHostLock(lock)) return isLeaseFresh(lock)
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

/**
 * A lock is "ready" when the server is not just live but has finished its
 * startup initialization (DB open + first-boot migrations) and can serve
 * real requests. `yaac server start` waits on this: the port binds and the
 * lock is written before that init runs, and the init blocks the single
 * event loop, so `isLockLive` can pass during the brief responsive window
 * beforehand — printing "server started" while the very next command's
 * `/health` probe times out against the frozen loop. Liveness (isLockLive)
 * stays the coarser signal used for lock reclamation / start idempotency,
 * where "ready" would wrongly classify a still-initializing server as stale.
 */
export async function isLockReady(lock: ServerLock): Promise<boolean> {
  // Off-host (the in-cluster server, read from the host): the readiness
  // flag lives behind a loopback this reader cannot dial, so the lease is
  // the only answer available. `yaac cluster install` waits on the
  // Deployment's own rollout for the stronger signal.
  if (!isSameHostLock(lock)) return isLeaseFresh(lock)
  if (!pidExists(lock.pid)) return false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 500)
    try {
      const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
        headers: { authorization: `Bearer ${lock.secret}` },
        signal: ctl.signal,
      })
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
