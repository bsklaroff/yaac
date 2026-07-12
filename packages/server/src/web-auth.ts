import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { env } from '@yaac/shared/env'

/** Name of the HttpOnly cookie that carries a webapp session. */
export const SESSION_COOKIE = 'yaac_session'

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
 * valid `yaac_session` cookie (webapp). Public paths skip the check.
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
    if (match && constantTimeEqual(match[1], secret)) return next()
    if (match && tokens.isValidToken(match[1])) return next()

    const sid = getCookie(c, SESSION_COOKIE)
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

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
