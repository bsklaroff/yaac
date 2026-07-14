/**
 * The dependency-free half of the server-lock contract: the lock's shape and
 * liveness semantics, with no `#…` or `@yaac/*` imports. Split out of
 * `#lock` (which owns the file I/O rooted at getDataDir()) so that
 * `packages/frontend/vite.config.ts` — loaded through esbuild, which can resolve
 * neither bare `@yaac/*` specifiers nor package `imports` maps at
 * config-load time — can share the exact same parsing and liveness rules via
 * a relative import instead of hand-rolling them.
 */

export interface ServerLock {
  pid: number
  port: number
  secret: string
  startedAt: number
  buildId: string
}

export const SERVER_LOCK_FILENAME = '.server.lock'

export function isServerLock(value: unknown): value is ServerLock {
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
 */
export async function isLockLive(lock: ServerLock): Promise<boolean> {
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
