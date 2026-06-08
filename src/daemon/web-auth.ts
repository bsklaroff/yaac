import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

/**
 * How long a freshly minted bootstrap code stays valid. Generous (24h)
 * on purpose: the code is single-use, 256-bit, and already retrievable
 * from `yaac daemon logs` for the daemon's lifetime, so a short TTL adds
 * little security but creates a real "code expired before I opened the
 * browser" papercut. It still rotates on every successful exchange.
 */
export const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000

/** Name of the HttpOnly cookie that carries a webapp session. */
export const SESSION_COOKIE = 'yaac_session'

/** Upper bound on retained webapp sessions (oldest evicted first). */
export const MAX_SESSIONS = 64

/**
 * Holds the single live bootstrap code and the set of minted browser
 * session ids. One instance per daemon lifetime; sessions die when the
 * daemon (and this in-memory store) goes away.
 *
 * The bootstrap code is single-use and time-bounded: a successful
 * exchange rotates it (so the consumed code can't be replayed) and mints
 * a fresh session id. See `webapp-frontend.md` for the threat model.
 */
export interface WebAuthStore {
  /** The bootstrap code to advertise in the start banner / `?bootstrap=`. */
  currentCode(): string
  /**
   * Validate and consume a bootstrap code. Returns a new session id on
   * success (and rotates the code), or null if the code is wrong,
   * already consumed, or older than the TTL.
   */
  consumeBootstrap(code: string, nowMs?: number): string | null
  /** True if `id` is a session minted by a prior bootstrap exchange. */
  isValidSession(id: string): boolean
  /** Invalidate every minted session (e.g. on shutdown). */
  revokeAll(): void
}

export function createWebAuthStore(
  opts: {
    ttlMs?: number
    now?: () => number
    /** Sessions to restore (e.g. persisted across a daemon restart). */
    initialSessions?: Iterable<string>
    /** Called whenever the live session set changes, for persistence. */
    onSessionsChanged?: (sessions: string[]) => void
  } = {},
): WebAuthStore {
  const ttlMs = opts.ttlMs ?? BOOTSTRAP_TTL_MS
  const now = opts.now ?? ((): number => Date.now())
  const sessions = new Set<string>(opts.initialSessions ?? [])
  const persist = (): void => opts.onSessionsChanged?.([...sessions])
  // Each bootstrap mints a session that's never explicitly revoked, so
  // cap the set (FIFO — Set preserves insertion order) to keep the
  // persisted file bounded across many `yaac open` invocations.
  const trim = (): void => {
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.values().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }
  trim()
  let code = newToken()
  let codeIssuedAt = now()

  return {
    currentCode: () => code,
    consumeBootstrap: (input, nowMs) => {
      const t = nowMs ?? now()
      if (t - codeIssuedAt > ttlMs) return null
      if (!constantTimeEqual(input, code)) return null
      // Single-use: rotate the code so this exact value can never be
      // replayed, and reset the clock for the next client.
      code = newToken()
      codeIssuedAt = t
      const id = newToken()
      sessions.add(id)
      trim()
      persist()
      return id
    },
    isValidSession: (id) => sessions.has(id),
    revokeAll: () => {
      sessions.clear()
      persist()
    },
  }
}

function newToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Routes reachable without any credential: the SPA shell, its hashed
 * assets, the health probe, and the bootstrap exchange itself.
 */
export function isPublicPath(path: string): boolean {
  if (path === '/health') return true
  if (path === '/auth/bootstrap') return true
  if (path === '/') return true
  if (path.startsWith('/assets/')) return true
  return false
}

/**
 * Accept a request if it carries either a matching bearer (CLI) or a
 * valid `yaac_session` cookie (webapp). Public paths skip the check.
 * Replaces the bearer-only middleware so both clients share one gate.
 */
export function cookieOrBearerAuth(
  secret: string,
  store: WebAuthStore,
): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicPath(c.req.path)) return next()

    const header = c.req.header('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match && constantTimeEqual(match[1], secret)) return next()

    const sid = getCookie(c, SESSION_COOKIE)
    if (sid && store.isValidSession(sid)) return next()

    return c.json(
      { error: { code: 'UNAUTHENTICATED', message: 'missing or invalid credentials' } },
      401,
    )
  }
}

/**
 * Reject requests whose `Host` header isn't loopback. Defeats DNS
 * rebinding, where an attacker domain resolves to 127.0.0.1 but the
 * browser still sends the attacker's hostname in `Host`.
 *
 * `boundPort` of 0 means "not bound yet" (in-process tests that never
 * call `serve`) — the port comparison is skipped there, but the
 * loopback-hostname check still applies.
 */
export function isAllowedHost(host: string, boundPort: number): boolean {
  if (!host) return false
  const [hostname, portStr] = host.split(':')
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false
  if (portStr && boundPort > 0 && portStr !== String(boundPort)) return false
  return true
}

export function hostHeaderCheck(getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    // Prefer the Host header (what a browser sends). Fall back to the
    // request URL's host for in-memory dispatch (hono's app.fetch in
    // tests) where no Host header is present. Real socket traffic always
    // carries Host, and a DNS-rebind request reflects the attacker host
    // in both the header and the URL, so the fallback doesn't weaken it.
    let host = c.req.header('host') ?? ''
    if (!host) {
      try {
        host = new URL(c.req.url).host
      } catch {
        host = ''
      }
    }
    if (isAllowedHost(host, getPort())) return next()
    return c.json(
      { error: { code: 'BAD_HOST', message: 'host not allowed' } },
      403,
    )
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
