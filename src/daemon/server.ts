import path from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { denyBrowserCors, requestLogger } from '@/daemon/auth'
import {
  cookieOrBearerAuth,
  createWebAuthStore,
  getRequestGuestScope,
  GUEST_COOKIE,
  hostHeaderCheck,
  mintGuestSession,
  resolveGuestScope,
  SESSION_COOKIE,
  type WebAuthStore,
} from '@/daemon/web-auth'
import { getValidInvite } from '@/daemon/invites'
import { registerStaticRoutes } from '@/daemon/static'
import { toErrorBody, rewriteZValidatorBody } from '@/daemon/errors'
import { projectApp } from '@/daemon/routes/project'
import { sessionApp } from '@/daemon/routes/session'
import { toolApp } from '@/daemon/routes/tool'
import { authApp } from '@/daemon/routes/auth'
import { readPrewarmSessions } from '@/lib/prewarm'
import { daemonLog } from '@/daemon/log'
import { PACKAGE_ROOT } from '@/shared/paths'

export interface DaemonAppDeps {
  secret: string
  buildId: string
  /**
   * Browser-auth store (bootstrap code + session cookies). Optional so
   * existing in-process tests can keep calling `buildApp({secret,
   * buildId})`; a fresh store is created when omitted.
   */
  store?: WebAuthStore
  /**
   * Returns the daemon's bound port for the Host-header check. Defaults
   * to a getter returning 0 ("not bound" — tests that never `serve`), in
   * which case only the loopback-hostname check applies.
   */
  getPort?: () => number
  /** Extra hostnames the Host-header check accepts (tailnet IP / MagicDNS
   *  name when tailnet sharing is on). */
  getExtraHostnames?: () => string[]
  /** Origin share links should use (e.g. http://100.x.y.z:port), null when
   *  the daemon is loopback-only. */
  getShareOrigin?: () => string | null
}

/**
 * Build the hono app. Kept as a factory so tests can instantiate it
 * without actually binding a TCP socket (hono apps expose `fetch` which
 * can be driven with `new Request(...)` directly).
 */
export function buildApp(deps: DaemonAppDeps) {
  const store = deps.store ?? createWebAuthStore()
  const getPort = deps.getPort ?? ((): number => 0)
  const app = new Hono()

  app.use('*', requestLogger())
  app.use('*', hostHeaderCheck(getPort, deps.getExtraHostnames ?? (() => [])))
  app.use('*', denyBrowserCors())
  app.use('*', cookieOrBearerAuth(deps.secret, store))
  // Guests (shared-session cookies) may only read their one session and
  // attach to its terminal; everything else is forbidden. Owner/bearer
  // requests carry no scope and skip this entirely.
  app.use('*', async (c, next) => {
    const scope = getRequestGuestScope(c)
    if (!scope) return next()
    const path = c.req.path
    const allowed =
      path === '/auth/me'
      || (c.req.method === 'GET' && path === `/session/${scope.sessionId}`)
      || (c.req.method === 'GET' && path === `/session/${scope.sessionId}/terminals`)
      || path === '/pty/attach'
    if (allowed) return next()
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'this share link only covers its session' } },
      403,
    )
  })
  app.use('*', async (c, next) => {
    await next()
    if (c.res.status !== 400) return
    if (!c.res.headers.get('content-type')?.includes('application/json')) return
    const raw: unknown = await c.res.clone().json().catch(() => null)
    const reshaped = rewriteZValidatorBody(raw)
    if (reshaped) c.res = c.json(reshaped, 400)
  })

  app.onError((err: Error, c: Context) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
  })

  app.notFound((c) => c.json(
    { error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } },
    404,
  ))

  // Browser auth bootstrap. Public (allowlisted in cookieOrBearerAuth):
  // exchanges a one-time code for an HttpOnly session cookie. Never log
  // the code value — only ok/fail.
  app.post('/auth/bootstrap', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const code = (body as { code?: unknown } | null)?.code
    if (typeof code !== 'string' || code.length === 0) {
      daemonLog('[daemon] bootstrap fail')
      return c.json({ error: { code: 'BAD_REQUEST', message: 'missing bootstrap code' } }, 400)
    }
    const sessionId = store.consumeBootstrap(code)
    if (!sessionId) {
      daemonLog('[daemon] bootstrap fail')
      return c.json(
        { error: { code: 'BAD_BOOTSTRAP', message: 'invalid or expired bootstrap code' } },
        401,
      )
    }
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      // No `Secure`: the daemon is http on loopback, and browsers reject
      // Secure cookies over http — setting it would drop the cookie.
    })
    daemonLog('[daemon] bootstrap ok')
    return c.body(null, 204)
  })

  // Authenticated (CLI bearer / existing cookie): return the current
  // bootstrap code so `yaac open` can build a ready-to-open authed URL
  // without scraping the daemon log. Not public — requires a credential.
  app.get('/auth/bootstrap-code', (c) => c.json({ code: store.currentCode() }))

  // Who am I: lets the SPA distinguish owner, guest (and the guest's
  // scope), or unauthenticated. Owner wins when both cookies are present;
  // `guest` is still reported so an owner can preview the guest view.
  app.get('/auth/me', async (c) => {
    const header = c.req.header('authorization') ?? ''
    const sid = getCookie(c, SESSION_COOKIE)
    const owner = /^Bearer\s+/.test(header) || !!(sid && store.isValidSession(sid))
    // Resolve the guest cookie directly (the auth middleware only does so
    // when owner auth fails) so an owner who opened a share link can still
    // preview the guest experience via ?guest=1.
    let scope = getRequestGuestScope(c) ?? null
    if (!scope) {
      const gid = getCookie(c, GUEST_COOKIE)
      if (gid) scope = await resolveGuestScope(gid)
    }
    return c.json({ owner, guest: scope, shareOrigin: deps.getShareOrigin?.() ?? null })
  })

  // Redeem a share link: validate the invite and set the guest cookie.
  // Public; the minted cookie is what carries the (scoped) access.
  app.get('/join', async (c) => {
    const code = c.req.query('code') ?? ''
    const invite = code ? await getValidInvite(code) : null
    if (!invite) {
      return c.json(
        { error: { code: 'BAD_INVITE', message: 'invalid or expired share link' } },
        401,
      )
    }
    setCookie(c, GUEST_COOKIE, mintGuestSession(invite.token), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    })
    daemonLog(`[daemon] guest joined session=${invite.sessionId} mode=${invite.mode}`)
    return c.redirect('/?guest=1')
  })

  // Serve the built SPA bundle when present (production: dist/frontend).
  // Absent in dev/test (Vite serves the app instead), so guard on it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  return app
    .get('/health', (c) => c.json({ ok: true, buildId: deps.buildId }))
    .get('/prewarm', async (c) => c.json(await readPrewarmSessions()))
    .route('/project', projectApp)
    .route('/session', sessionApp)
    .route('/tool', toolApp)
    .route('/auth', authApp)
}

export type AppType = ReturnType<typeof buildApp>
