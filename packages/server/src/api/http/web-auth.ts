import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { env } from '@yaac/shared/env'
// Install IDENTITY, not storage — the cookie hash must stay stable when
// the storage tiers split (see sessionCookieName below).
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
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
 * it gives each co-hosted server an independent cookie. Like the cluster
 * label hash, this uses the install root as an IDENTITY rather than as a
 * storage tier, so it is unaffected when the tiers split. Memoized per data
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
  // The in-worktree command channel, which carries its own credential: a
  // worktree holds a per-worktree bearer, never the server secret this gate
  // checks, and the route rejects anything else. Public here in the same
  // sense the exchange above is — the gate does not apply because a
  // stricter, per-caller one does (see `/worktree/mama`).
  if (path === '/worktree/mama') return method === 'POST'
  if (path === '/') return true
  if (path.startsWith('/assets/')) return true
  return false
}

/**
 * True when the server is a purely-local deployment: bound loopback-only,
 * with no remote hosting configured (`YAAC_ALLOWED_HOSTS` empty and
 * `YAAC_TRUST_PROXY` unset).
 */
export function isLoopbackOnlyDeployment(): boolean {
  return env.allowedHosts.length === 0 && !env.trustProxy
}

/**
 * Whether the credential gate is skipped for this deployment — a browser or
 * CLI reaching it needs no token. Skipped when the server isn't deliberately
 * remote-fronted for direct external access:
 *   - a pure loopback deployment (`isLoopbackOnlyDeployment`), or
 *   - a yaac running inside a worktree (`YAAC_WORKTREE_ID`): it can pick up
 *     the outer install's `allowedHosts`/`trustProxy` through the project's
 *     `envPassthrough` — ambient env, not a remote-fronting of this inner
 *     server, because nothing outside the machine addresses it unmediated.
 *     Under k8s the only path in is the outer server's port-forward, already
 *     tailnet-gated like any forwarded port; under containerless the inner
 *     server binds host loopback, which this model already trusts. Keyed on
 *     the worktree id because the reasoning holds for every worktree and
 *     `createWorktree` stamps it on all of them, under both drivers. The
 *     cost is that a server someone
 *     deliberately fronts, but starts from a shell inside a worktree, also
 *     skips the gate — `YAAC_REQUIRE_AUTH=1` is the answer there
 *     (docs/remote-hosting.md).
 * `YAAC_REQUIRE_AUTH` forces the gate on regardless (shared machines; a
 * deliberately-gated inner server; the auth-path tests). The Host + Origin +
 * Sec-Fetch-Site guards still defeat a malicious website in every case. Read
 * per request (never cached) so a restarted server — and tests — see current
 * env.
 */
export function isCredentialOptional(): boolean {
  if (env.requireAuth) return false
  return env.worktreeId !== undefined || isLoopbackOnlyDeployment()
}

/**
 * Accept a request if it carries either a matching bearer (CLI) or a
 * valid webapp session cookie. Public paths skip the check, and a
 * deployment where the credential is optional skips it entirely (see
 * `isCredentialOptional`) unless `YAAC_REQUIRE_AUTH` forces it on.
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
    if (isCredentialOptional()) return next()

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

/**
 * Whether a request's `Origin` is allowed. Mirrors `isAllowedHost`, applied
 * to the origin's host: absent Origin (non-browser clients — CLI/undici,
 * curl — and same-origin GETs, which browsers may send without one) is
 * allowed; a present Origin must resolve to loopback or an allow-listed host.
 *
 * This is the load-bearing defense for a credential-free loopback server:
 * `Origin` is browser-controlled and page JS cannot forge or drop it (a Fetch
 * "forbidden header"; the WebSocket constructor has no header API), so a
 * request from a malicious site arrives stamped with the attacker's origin
 * and is rejected. `Origin: null` (opaque origins) is unparseable and fails
 * closed. Kept as hardening even when the credential gate is on.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[] = []): boolean {
  if (origin === undefined || origin === '') return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  return isAllowedHost(host, allowed)
}

export function originHeaderCheck(): MiddlewareHandler {
  return async (c, next) => {
    // Read per request (never cached) so tests — and a server restarted with
    // new env — see the current allowlist.
    if (isAllowedOrigin(c.req.header('origin'), env.allowedHosts)) return next()
    return c.json(
      { error: { code: 'BAD_ORIGIN', message: 'origin not allowed' } },
      403,
    )
  }
}

/**
 * Fetch-metadata "resource isolation" check: reject a request the browser
 * marks as coming from another site. `Sec-Fetch-Site` is set by the browser
 * and page JS cannot forge it (like `Origin`), and the browser attaches it to
 * more request shapes than `Origin` — so it catches cross-site requests even
 * where `Origin` is absent. Complementary hardening alongside
 * `isAllowedOrigin`; both must pass.
 *
 * Allowed: an absent header (non-browser clients, older browsers — `Origin`
 * and Host still guard those), `same-origin` (the SPA's own fetches/WS), and
 * `none` (a user-initiated load: typed URL, bookmark, `yaac open`). A
 * cross-site *top-level document* navigation (GET + `Sec-Fetch-Mode: navigate`
 * + `Sec-Fetch-Dest: document`) is allowed so the webapp stays linkable — but
 * an embedded navigation (`Sec-Fetch-Dest: iframe`/`embed`/…) is not, so a
 * site can't frame the app across origins. Everything else (`cross-site` /
 * `same-site` sub-resource loads) is rejected.
 */
export function isAllowedFetchSite(
  site: string | undefined,
  mode: string | undefined,
  dest: string | undefined,
  method: string,
): boolean {
  if (site === undefined || site === '') return true
  if (site === 'same-origin' || site === 'none') return true
  if (method === 'GET' && mode === 'navigate' && dest === 'document') return true
  return false
}

export function fetchSiteCheck(): MiddlewareHandler {
  return async (c, next) => {
    if (isAllowedFetchSite(
      c.req.header('sec-fetch-site'),
      c.req.header('sec-fetch-mode'),
      c.req.header('sec-fetch-dest'),
      c.req.method,
    )) return next()
    return c.json(
      { error: { code: 'BAD_FETCH_SITE', message: 'cross-site request rejected' } },
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
