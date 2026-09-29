import type { MiddlewareHandler } from 'hono'
import { env } from '@yaac/shared/env'
import type { Principal } from '@yaac/shared/types'

/** What `identify()` stores on the context for the routes after it. */
export interface IdentityEnv {
  Variables: { principal: Principal }
}

/**
 * Routes reachable without an identity: the SPA shell and its hashed
 * assets — public so that an unidentified browser can still load the app
 * and be told what is wrong — and the health probe.
 */
function isPublicPath(path: string): boolean {
  return path === '/api/health' || path === '/' || path.startsWith('/assets/')
}

/**
 * The request's host as the guards see it: the `Host` header, or the URL's
 * host for in-memory dispatch (hono's `app.fetch` in tests), which carries
 * no header. Real socket traffic always carries Host, and a DNS-rebind
 * request reflects the attacker host in both, so the fallback weakens
 * nothing. Lowercased, port kept.
 */
function requestHost(header: string | undefined, url: string): string {
  if (header) return header.toLowerCase()
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

/** One RFC 2047 encoded word, `=?utf-8?q?…?=` or `?b?`, as bytes. */
const ENCODED_WORD = /=\?utf-8\?([qb])\?([^?]*)\?=/gi

function encodedWordBytes(encoding: string, text: string): number[] {
  if (encoding.toLowerCase() === 'b') return [...Buffer.from(text, 'base64')]
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '_') bytes.push(0x20)
    else if (text[i] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(text.charCodeAt(i))
  }
  return bytes
}

/**
 * An identity header as text to show and log. A non-ASCII value arrives as
 * RFC 2047 encoded words — several, space-separated, once it is longer than
 * one word may be — which are decoded together, the whitespace between
 * adjacent words dropped as the RFC says. Control characters are removed
 * whatever the encoding: the value goes into every request-log line and
 * into what `yaac remote set` prints.
 */
function decodeIdentityHeader(value: string): string {
  const words = [...value.trim().matchAll(ENCODED_WORD)]
  const whole = words.length > 0
    && words.map((w) => w[0]).join(' ') === value.trim().replace(/\s+/g, ' ')
  const text = whole
    ? Buffer.from(words.flatMap((w) => encodedWordBytes(w[1], w[2]))).toString('utf8')
    : value
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

/**
 * Who a request is from, derived from the request itself
 * (docs/remote-hosting.md), or why it cannot be said.
 *
 * `tailscale serve` — a host `serve`, or the Tailscale operator's Ingress
 * proxy, which is the same code — stamps `X-Forwarded-For` on everything
 * it forwards, `Tailscale-User-Login`/`-Name` on what comes from a
 * user-owned device, and strips client-supplied copies of those. So:
 *
 * - Forwarded (either header present) and carrying a user: that tailnet
 *   user.
 * - Forwarded without one: a tagged device or Funnel, which has no user to
 *   be. Refused.
 * - Not forwarded, addressed to loopback: this machine — local.
 * - Not forwarded, addressed to any other name: a path that is not
 *   `serve` and not loopback, which a top-level server refuses rather than
 *   trust — the fail-closed half, since `YAAC_ALLOWED_HOSTS` is what opts
 *   a server into remote access and remote access is identity-only. A
 *   server inside a worktree (`YAAC_WORKTREE_ID`) is reached exactly that
 *   way, as `srv.<tailnet>:<port>` through the outer install's forward, so
 *   there it is local.
 *
 * A local process can forge any of these headers, and gains nothing by it:
 * it is the owner already. The bind (loopback unless in-cluster) and, in
 * the cluster, the server pod's ingress policy are what keep everything
 * else from reaching the server unmediated.
 */
function identifyRequest(
  header: (name: string) => string | undefined,
  url: string,
): Principal | { refused: string } {
  const login = header('tailscale-user-login')
  const proxied = header('x-forwarded-for') !== undefined
    || login !== undefined
    || header('tailscale-user-name') !== undefined
  if (proxied) {
    if (login) {
      const name = header('tailscale-user-name')
      return {
        kind: 'tailnet',
        login: decodeIdentityHeader(login),
        name: name ? decodeIdentityHeader(name) : decodeIdentityHeader(login),
      }
    }
    return {
      refused: 'tailscale serve sent no user identity: this device is a tagged device, '
        + 'or the request came through Funnel. Reach the server from a device '
        + 'logged in as a tailnet user.',
    }
  }
  const hostname = requestHost(header('host'), url).split(':')[0]
  if (isLoopbackHostname(hostname) || env.worktreeId !== undefined) return { kind: 'local' }
  return {
    refused: `reached as ${hostname} without tailscale serve: a server is reached `
      + 'at loopback on its own machine, and through tailscale serve from '
      + 'anywhere else (docs/remote-hosting.md).',
  }
}

/**
 * The identity gate: every non-public request gets a `principal`, or a 401
 * saying why it could not be given one (`identifyRequest`). Runs after the
 * Host, CORS, Origin and Sec-Fetch-Site guards, and on WebSocket upgrades
 * like any other request. Read per request (never cached) so a restarted
 * server — and tests — see the current environment.
 */
export function identify(): MiddlewareHandler<IdentityEnv> {
  return async (c, next) => {
    if (isPublicPath(c.req.path)) return next()
    const who = identifyRequest((name) => c.req.header(name), c.req.url)
    if ('refused' in who) {
      return c.json({ error: { code: 'UNAUTHENTICATED', message: who.refused } }, 401)
    }
    c.set('principal', who)
    return next()
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
    // Read per request (never cached) so tests — and a server restarted
    // with new env — see the current allowlist.
    if (isAllowedHost(requestHost(c.req.header('host'), c.req.url), env.allowedHosts)) return next()
    return c.json(
      { error: { code: 'BAD_HOST', message: 'host not allowed' } },
      403,
    )
  }
}

/**
 * Whether a request's `Origin` is the request's own origin: the scheme,
 * host AND port it was sent to. `host` is the Host guard's reading; the
 * scheme is `https` when `tailscale serve` terminated TLS in front of us
 * (its `X-Forwarded-Proto`) and plain `http` otherwise, since the server
 * itself serves nothing else. Absent Origin (non-browser clients —
 * CLI/undici, curl — and same-origin GETs, which browsers may send without
 * one) is allowed.
 *
 * The port is the point. Every page served on the server's hostname at
 * another port — a worktree's forwarded dev server on `127.0.0.1:<port>`,
 * the desktop's preview pane, `srv.<tailnet>.ts.net:19500` — runs untrusted
 * repo code, and a hostname comparison would admit it. `Origin` is
 * browser-controlled and page JS cannot forge or drop it (a Fetch
 * "forbidden header"; the WebSocket constructor has no header API), so
 * such a page, or any other site, arrives stamped with its own origin and
 * is rejected — nor can it add the `X-Forwarded-Proto` that would make an
 * `http` page look like the `https` one, since any custom header needs a
 * preflight (`denyBrowserCors`). Host and Origin both come from the URL the
 * browser targeted, so a port-forward that remaps the port leaves them
 * equal, and `tailscale serve` preserves Host. `Origin: null` (opaque origins) is unparseable and
 * fails closed.
 */
export function isAllowedOrigin(origin: string | undefined, host: string, forwardedProto?: string): boolean {
  if (origin === undefined || origin === '') return true
  const scheme = forwardedProto?.toLowerCase() === 'https' ? 'https' : 'http'
  try {
    // Both through URL, so a default port written in Host (`:443`) compares
    // equal to one the Origin leaves out.
    return new URL(origin).origin === new URL(`${scheme}://${host}`).origin
  } catch {
    return false
  }
}

export function originHeaderCheck(): MiddlewareHandler {
  return async (c, next) => {
    const host = requestHost(c.req.header('host'), c.req.url)
    if (isAllowedOrigin(c.req.header('origin'), host, c.req.header('x-forwarded-proto'))) return next()
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
 * `none` (a user-initiated load: typed URL, bookmark, a pasted banner URL). A
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
