import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { env } from '@yaac/shared/env'
import { getDataDir } from '@yaac/shared/paths'

/** Base name of the HttpOnly cookie that carries a webapp session. */
export const SESSION_COOKIE_BASE = 'yaac_session'

let cookieNameCache: { dir: string; name: string } | null = null

/**
 * Name of THIS server instance's webapp session cookie —
 * `yaac_session_<hash>`, where `<hash>` is a short digest of the server's
 * data dir. Cookies are scoped by host, not by port, so two yaac servers
 * reachable under one hostname — e.g. an outer server behind `tailscale
 * serve` (https) and a nested one on a forwarded http port — would otherwise
 * share the bare `yaac_session` cookie and clobber each other's sessions.
 * Worse, the https server's `Secure` cookie blocks the http server from
 * storing a same-named one at all (browsers refuse to let an insecure origin
 * overwrite a Secure cookie), stranding the nested webapp unauthenticated.
 * The data dir is unique per install (1:1 with the server lock), so hashing
 * it gives each co-hosted server an independent cookie. Memoized per data
 * dir; re-derives when it changes (tests call `setDataDir`).
 */
export function sessionCookieName(): string {
  const dir = getDataDir()
  if (cookieNameCache?.dir === dir) return cookieNameCache.name
  const suffix = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)
  const name = `${SESSION_COOKIE_BASE}_${suffix}`
  cookieNameCache = { dir, name }
  return name
}

/**
 * Routes reachable without any credential: the SPA shell, its hashed
 * assets, the health probe, and the token→cookie exchange itself. The
 * exchange is public only for POST — GET /auth/web-session is the
 * authenticated "is my cookie still good" probe and must stay gated.
 */
export function isPublicPath(method: string, path: string): boolean {
  if (path === '/health') return true
  if (path === '/auth/web-session') return method === 'POST'
  if (path === '/') return true
  if (path.startsWith('/assets/')) return true
  return false
}

/**
 * Accept a request if it carries either a matching bearer (CLI) or a
 * valid webapp session cookie. Public paths skip the check.
 *
 * A presented-but-wrong bearer is answered with `BAD_BEARER` rather than
 * the generic `UNAUTHENTICATED`: the CLI client re-reads its credential
 * source and retries exactly once on that code (a restarted server
 * rotates the lock secret out from under a long-lived CLI process).
 *
 * `tokens` extends the bearer check to durable client tokens (remote
 * CLIs can never read the lock file) and owns the web sessions the
 * cookie is checked against. Structural type rather than the TokenStore
 * import to keep this module free of server-store dependencies.
 */
export function cookieOrBearerAuth(
  secret: string,
  tokens: {
    isValidToken(candidate: string): boolean
    isValidSession(candidate: string): boolean
  },
): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicPath(c.req.method, c.req.path)) return next()

    const header = c.req.header('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match && timingSafeStrEqual(match[1], secret)) return next()
    if (match && tokens.isValidToken(match[1])) return next()

    const sid = getCookie(c, sessionCookieName())
    if (sid && tokens.isValidSession(sid)) return next()

    if (match) {
      return c.json(
        { error: { code: 'BAD_BEARER', message: 'bearer token rejected' } },
        401,
      )
    }
    return c.json(
      { error: { code: 'UNAUTHENTICATED', message: 'missing or invalid credentials' } },
      401,
    )
  }
}

/**
 * Reject requests whose `Host` header isn't loopback (or an explicitly
 * allowed extra hostname — `YAAC_ALLOWED_HOSTS`, for the tailnet name a
 * `tailscale serve` proxy forwards). Defeats DNS rebinding, where an
 * attacker domain resolves to 127.0.0.1 but the browser still sends the
 * attacker's hostname in `Host`. Loopback is allowed unconditionally so
 * the extra-hosts knob can only widen, never weaken, local access.
 *
 * Only the hostname is checked, not the port: a port-forward (common
 * when reaching the server from outside its container) legitimately
 * remaps the external port, so the browser's `Host` port need not equal
 * the server's bound port. The port comparison would add no real defense
 * anyway — a DNS-rebind request must already target the server's real
 * port to connect, so its `Host` port would match regardless.
 */
export function isAllowedHost(host: string, allowed: readonly string[] = []): boolean {
  if (!host) return false
  const [hostname] = host.toLowerCase().split(':')
  if (hostname === '127.0.0.1' || hostname === 'localhost') return true
  return allowed.includes(hostname)
}

export function hostHeaderCheck(): MiddlewareHandler {
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
    // Read per request (never cached) so tests — and a server restarted
    // with new env — see the current allowlist.
    if (isAllowedHost(host, env.allowedHosts)) return next()
    return c.json(
      { error: { code: 'BAD_HOST', message: 'host not allowed' } },
      403,
    )
  }
}

export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on unequal-length inputs; a length mismatch is not
  // itself secret (these are fixed-width tokens), so short-circuit it. The
  // point is not to leak — via the compare's timing — how long a matching
  // prefix an attacker guessed.
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}
