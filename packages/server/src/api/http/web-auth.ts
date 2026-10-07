import type { MiddlewareHandler } from 'hono'
import { env } from '@yaac/shared/env'
import type { AccessMode, Principal } from '@yaac/shared/types'
import { BUILT_IN_USER_ID, seeTailnetUser } from '#db'

/** What `identify()` stores on the context for the routes after it. */
export interface IdentityEnv {
  Variables: { principal: Principal }
}

/** Who sent a request, before it is matched to a user. */
type Caller = { kind: 'local' } | { kind: 'tailnet'; login: string; name: string }

/**
 * Routes reachable without an identity: the health probe, and the SPA shell
 * and assets, so an unidentified browser can still load the app and be told
 * what is wrong.
 */
function isPublicPath(path: string): boolean {
  return path === '/api/health' || path === '/' || path.startsWith('/assets/')
}

/**
 * The request's host, lowercased with the port kept: the `Host` header, or
 * the URL's host for in-memory dispatch (`app.fetch` in tests), which has no
 * header. Real traffic always has Host, and a DNS-rebind request carries the
 * attacker's host in both, so the fallback is safe.
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
 * Decode an identity header for display and logging. Non-ASCII values arrive
 * as one or more space-separated RFC 2047 encoded words, decoded together
 * with the whitespace between them dropped. Control characters are always
 * removed, since the value goes into request logs and `yaac remote set`
 * output.
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
 * Who a request is from, or why that can't be determined
 * (docs/remote-hosting.md).
 *
 * `tailscale serve` (on the host, or the Tailscale operator's Ingress proxy)
 * sets `X-Forwarded-For` on everything it forwards, sets
 * `Tailscale-User-Login`/`-Name` for user-owned devices, and strips
 * client-supplied copies. So:
 *
 * - Forwarded with a user: that tailnet user.
 * - Forwarded without a user (a tagged device or Funnel): refused.
 * - Not forwarded, addressed to loopback: local.
 * - Not forwarded, addressed to another name: refused (fail closed), since
 *   remote access requires an identity. Exception: a server inside a
 *   workspace (`YAAC_WORKSPACE_ID`) is reached this way through the outer
 *   install's forward, so there it is local.
 *
 * A local process can forge these headers, and in tailnet mode claim any
 * login, but gains nothing: it already owns the data dir. Everything else
 * is kept out by the loopback bind, or in-cluster by the server pod's
 * ingress policy.
 */
function identifyRequest(
  header: (name: string) => string | undefined,
  url: string,
): Caller | { refused: string } {
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
  if (isLoopbackHostname(hostname) || env.workspaceId !== undefined) return { kind: 'local' }
  return {
    refused: `reached as ${hostname} without tailscale serve: a server is reached `
      + 'at loopback on its own machine, and through tailscale serve from '
      + 'anywhere else (docs/remote-hosting.md).',
  }
}

/**
 * Why the install's access mode refuses a caller, or null if it admits it
 * (docs/remote-hosting.md "Access modes"). `local` admits only callers that
 * did not come through serve; `tailnet` only those that did.
 */
function modeRefusal(mode: AccessMode, who: Caller): string | null {
  if (mode === 'local' && who.kind === 'tailnet') {
    return 'this server runs in local mode and admits only its own machine. To serve '
      + 'tailnet users, start it with `yaac server start --tailnet <host>` (or '
      + '`yaac cluster install --tailnet`) (docs/remote-hosting.md).'
  }
  if (mode === 'tailnet' && who.kind === 'local') {
    return 'this server runs in tailnet mode and admits only requests through tailscale '
      + 'serve, so reach it at its tailnet name, from this machine too (docs/remote-hosting.md).'
  }
  return null
}

/**
 * The identity gate: every non-public request gets a `principal`, or a 401
 * explaining why not (`identifyRequest`, then the access `mode`). Runs after
 * the Host, CORS, Origin and Sec-Fetch-Site guards, including on WebSocket
 * upgrades. Until startup has settled the mode it answers 503, and a refused
 * start answers 503 with its reason for as long as it runs.
 *
 * One exception to `tailnet` mode's "no loopback": a containerless
 * workspace's `yaac-mama` posts to `/workspace/mama` over loopback, and that
 * route authenticates the workspace's bearer token itself.
 */
export function identify(
  access: () => AccessMode | { refused: string } | undefined,
): MiddlewareHandler<IdentityEnv> {
  return async (c, next) => {
    if (isPublicPath(c.req.path)) return next()
    const current = access()
    if (typeof current !== 'string') {
      const message = current === undefined
        ? 'the server is still starting'
        : `the server refused to start: ${current.refused}`
      return c.json({ error: { code: 'RUNTIME_UNAVAILABLE', message } }, 503)
    }
    const who = identifyRequest((name) => c.req.header(name), c.req.url)
    if ('refused' in who) return c.json({ error: { code: 'UNAUTHENTICATED', message: who.refused } }, 401)
    const refused = modeRefusal(current, who)
    if (refused !== null) {
      if (who.kind === 'local' && c.req.method === 'POST' && c.req.path === '/api/workspace/mama') return next()
      return c.json({ error: { code: 'UNAUTHENTICATED', message: refused } }, 401)
    }
    c.set('principal', who.kind === 'local'
      ? { kind: 'local', userId: BUILT_IN_USER_ID }
      : { ...who, userId: await seeTailnetUser(who.login, who.name) })
    return next()
  }
}

/**
 * Allow only a loopback `Host`, or a hostname listed in `YAAC_ALLOWED_HOSTS`
 * (the tailnet name `tailscale serve` forwards). This defeats DNS rebinding,
 * where an attacker domain resolves to 127.0.0.1 but the browser still sends
 * the attacker's hostname. Loopback is always allowed.
 *
 * Only the hostname is checked: a port-forward can legitimately remap the
 * port, and a rebind request must hit the real port anyway.
 */
export function isAllowedHost(host: string, allowed: readonly string[] = []): boolean {
  if (!host) return false
  const [hostname] = host.toLowerCase().split(':')
  if (hostname === '127.0.0.1' || hostname === 'localhost') return true
  return allowed.includes(hostname)
}

export function hostHeaderCheck(): MiddlewareHandler {
  return async (c, next) => {
    // Read per request so tests see the current allowlist.
    if (isAllowedHost(requestHost(c.req.header('host'), c.req.url), env.allowedHosts)) return next()
    return c.json(
      { error: { code: 'BAD_HOST', message: 'host not allowed' } },
      403,
    )
  }
}

/**
 * Whether a request's `Origin` equals the scheme, host and port it was sent
 * to. The scheme is `https` when `tailscale serve` terminated TLS
 * (`X-Forwarded-Proto`), else `http`. A missing Origin (CLI, curl, some
 * same-origin GETs) is allowed.
 *
 * The port matters: pages on the same hostname at other ports (a forwarded
 * dev server, the desktop preview pane) run untrusted repo code. Page JS
 * can't forge or drop `Origin`, and can't add `X-Forwarded-Proto` without a
 * preflight, which `denyBrowserCors` refuses. A port-forward keeps Host and
 * Origin equal, and `tailscale serve` preserves Host. `Origin: null` fails
 * to parse and is refused.
 */
export function isAllowedOrigin(origin: string | undefined, host: string, forwardedProto?: string): boolean {
  if (origin === undefined || origin === '') return true
  const scheme = forwardedProto?.toLowerCase() === 'https' ? 'https' : 'http'
  try {
    // Parse both, so an explicit default port in Host (`:443`) matches an
    // Origin that omits it.
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
 * Fetch-metadata check: reject requests the browser marks as cross-site.
 * `Sec-Fetch-Site` can't be forged by page JS and is sent on more requests
 * than `Origin`, so it complements `isAllowedOrigin`; both must pass.
 *
 * Allowed: no header (non-browser clients, older browsers), `same-origin`,
 * `none` (typed URL, bookmark), and a cross-site top-level document
 * navigation so the webapp stays linkable. Embedded navigations (iframes)
 * and cross-site or same-site subresource requests are rejected.
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
