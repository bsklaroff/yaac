import path from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { denyBrowserCors, requestLogger } from '@/daemon/auth'
import {
  cookieOrBearerAuth,
  createWebAuthStore,
  hostHeaderCheck,
  SESSION_COOKIE,
  type WebAuthStore,
} from '@/daemon/web-auth'
import { registerStaticRoutes } from '@/daemon/static'
import { toErrorBody, rewriteZValidatorBody } from '@/daemon/errors'
import { projectApp } from '@/daemon/routes/project'
import { sessionApp } from '@/daemon/routes/session'
import { toolApp } from '@/daemon/routes/tool'
import { authApp } from '@/daemon/routes/auth'
import { shortcutsApp } from '@/daemon/routes/shortcuts'
import { configApp } from '@/daemon/routes/config'
import { imageApp } from '@/daemon/routes/image'
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
}

/**
 * Build the hono app. Kept as a factory so tests can instantiate it
 * without actually binding a TCP socket (hono apps expose `fetch` which
 * can be driven with `new Request(...)` directly).
 */
export function buildApp(deps: DaemonAppDeps) {
  const store = deps.store ?? createWebAuthStore()
  const app = new Hono()

  app.use('*', requestLogger())
  app.use('*', hostHeaderCheck())
  app.use('*', denyBrowserCors())
  app.use('*', cookieOrBearerAuth(deps.secret, store))
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

  // Serve the built SPA bundle when present (production: dist/frontend).
  // Absent in dev/test (Vite serves the app instead), so guard on it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  return app
    .get('/health', (c) => c.json({ ok: true, buildId: deps.buildId }))
    .route('/project', projectApp)
    .route('/session', sessionApp)
    .route('/tool', toolApp)
    .route('/auth', authApp)
    .route('/shortcuts', shortcutsApp)
    .route('/config', configApp)
    .route('/image', imageApp)
}

export type AppType = ReturnType<typeof buildApp>
