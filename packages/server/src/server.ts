import path from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { denyBrowserCors, requestLogger } from '#auth'
import { cookieOrBearerAuth, hostHeaderCheck, sessionCookieName } from '#web-auth'
import { registerStaticRoutes } from '#static'
import { toErrorBody } from '#errors'
import { projectApp } from '#routes/project'
import { sessionApp } from '#routes/session'
import { toolApp } from '#routes/tool'
import { scheduleApp } from '#routes/schedule'
import { authApp } from '#routes/auth'
import { createClusterApp, type ClusterRouteDeps } from '#routes/cluster'
import { createTokensApp } from '#routes/tokens'
import { shortcutsApp } from '#routes/shortcuts'
import { configApp } from '#routes/config'
import { imageApp } from '#routes/image'
import { serverLog } from '#log'
import { createTokenStore, type TokenStore } from '#token-store'
import { env } from '@yaac/shared/env'
import { PACKAGE_ROOT } from '@yaac/shared/paths'

export interface ServerAppDeps {
  secret: string
  buildId: string
  /**
   * Token store (durable client tokens + one-time exchange tokens + web
   * sessions). Optional so existing in-process tests can keep calling
   * `buildApp({secret, buildId})`; a fresh empty store (nothing but the
   * lock secret authenticates) is created when omitted.
   */
  tokens?: TokenStore
  /**
   * Cluster check/setup backing for /cluster. Optional for the same reason
   * as `tokens`; the default shells out to kubectl/kind (never exercised by
   * unit tests — they inject fakes).
   */
  cluster?: ClusterRouteDeps
  /**
   * Reports whether startup initialization (DB open + first-boot
   * migrations) has finished. Surfaced on `/health` as `ready` so `yaac
   * server start` can wait for genuine readiness — the port binds and the
   * lock is written before that init runs, and the init blocks the single
   * event loop, so a bare liveness probe can pass in the responsive window
   * beforehand and print "server started" prematurely. Defaults to
   * always-ready for in-process tests that never boot the DB.
   */
  isReady?: () => boolean
}

/**
 * Build the hono app. Kept as a factory so tests can instantiate it
 * without actually binding a TCP socket (hono apps expose `fetch` which
 * can be driven with `new Request(...)` directly).
 */
export function buildApp(deps: ServerAppDeps) {
  const tokens = deps.tokens ?? createTokenStore()
  const isReady = deps.isReady ?? (() => true)
  const app = new Hono()

  app.use('*', requestLogger())
  // Stamp every response with the server build so a remote CLI (which
  // can't compare lock buildIds) can warn on version skew.
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('x-yaac-build-id', deps.buildId)
  })
  app.use('*', hostHeaderCheck())
  app.use('*', denyBrowserCors())
  app.use('*', cookieOrBearerAuth(deps.secret, tokens))

  app.onError((err: Error, c: Context) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
  })

  app.notFound((c) => c.json(
    { error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } },
    404,
  ))

  // Browser session mint. POST is public (allowlisted in
  // cookieOrBearerAuth): exchanges a token — one-time from `yaac open`,
  // or a pasted durable token — for an HttpOnly session cookie. Never
  // log the token value — only ok/fail.
  app.post('/auth/web-session', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const token = (body as { token?: unknown } | null)?.token
    if (typeof token !== 'string' || token.length === 0) {
      serverLog('[server] web-session exchange fail')
      return c.json({ error: { code: 'BAD_REQUEST', message: 'missing token' } }, 400)
    }
    const sessionId = tokens.consumeExchange(token)
    if (!sessionId) {
      serverLog('[server] web-session exchange fail')
      return c.json(
        { error: { code: 'BAD_TOKEN', message: 'invalid or expired token' } },
        401,
      )
    }
    setCookie(c, sessionCookieName(), sessionId, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      // `Secure` only when a trusted TLS-terminating proxy (tailscale
      // serve) says the outer leg was https. Gated on YAAC_TRUST_PROXY so
      // a direct-loopback request can't spoof X-Forwarded-Proto into a
      // posture change; on plain loopback http the flag stays off because
      // browsers drop Secure cookies set over http.
      secure: env.trustProxy && c.req.header('x-forwarded-proto') === 'https',
    })
    serverLog('[server] web-session exchange ok')
    return c.body(null, 204)
  })

  // Authenticated (cookie or bearer) no-op: the SPA probes it on load to
  // learn whether its session cookie is still good.
  app.get('/auth/web-session', (c) => c.body(null, 204))

  // Serve the built SPA bundle when present (production: dist/frontend).
  // Absent in dev/test (Vite serves the app instead), so guard on it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  return app
    .get('/health', (c) => c.json({ ok: true, buildId: deps.buildId, ready: isReady() }))
    .route('/project', projectApp)
    .route('/session', sessionApp)
    .route('/tool', toolApp)
    .route('/schedule', scheduleApp)
    .route('/tokens', createTokensApp(tokens))
    .route('/auth', authApp)
    .route('/shortcuts', shortcutsApp)
    .route('/config', configApp)
    .route('/image', imageApp)
    .route('/cluster', createClusterApp(deps.cluster))
}

export type AppType = ReturnType<typeof buildApp>
