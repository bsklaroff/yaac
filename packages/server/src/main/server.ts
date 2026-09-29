import path from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  denyBrowserCors,
  fetchSiteCheck,
  hostHeaderCheck,
  identify,
  originHeaderCheck,
  registerStaticRoutes,
  requestLogger,
  toErrorBody,
  type IdentityEnv,
} from '#http'
import { projectApp } from '#routes/projects'
import { worktreeApp } from '#routes/worktrees'
import { authApp } from '#routes/auth'
import { shortcutsApp } from '#routes/shortcuts'
import { configApp } from '#routes/config'
import { imageApp } from '#routes/images'
import { hasWorktreeDriver, worktreeDriver } from '#drivers/driver'
import { PACKAGE_ROOT } from '@yaac/shared/paths'

export interface ServerAppDeps {
  buildId: string
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
  const isReady = deps.isReady ?? (() => true)
  const app = new Hono<IdentityEnv>()

  app.use('*', requestLogger())
  // Stamp every response with the server build so a remote CLI (which
  // can't compare lock buildIds) can warn on version skew.
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('x-yaac-build-id', deps.buildId)
  })
  app.use('*', hostHeaderCheck())
  app.use('*', denyBrowserCors())
  // Reject cross-site requests two ways (both browser-set, JS-unforgeable,
  // and effective on WS upgrades, which are never preflighted), because a
  // browser's identity is ambient — loopback or tailnet, a malicious site's
  // request would carry it: the request's Origin (which must be the very
  // origin it was sent to, port included), and the Fetch-metadata
  // Sec-Fetch-Site signal.
  app.use('*', originHeaderCheck())
  app.use('*', fetchSiteCheck())
  app.use('*', identify())

  app.onError((err: Error, c: Context) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
  })

  app.notFound((c) => c.json(
    { error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } },
    404,
  ))

  // Serve the built SPA bundle when present (production: dist/frontend).
  // Absent in dev/test (Vite serves the app instead), so guard on it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  return app
    .get('/health', (c) => c.json({
      ok: true,
      buildId: deps.buildId,
      ready: isReady(),
      // Which substrate this server runs, or null before the composition
      // root has registered one. Here as well as on the snapshot because a
      // caller may need it before it is identified: `yaac cluster …`
      // asks this to decide whether it means anything against THIS server,
      // rather than trusting its own shell's YAAC_DRIVER — a server started
      // elsewhere leaves no trace in it.
      driver: hasWorktreeDriver() ? worktreeDriver().kind : null,
    }))
    // Who the server takes this caller to be — the SPA's bootstrap and the
    // clients' "will this server take my requests" probe.
    .get('/whoami', (c) => c.json(c.get('principal')))
    .route('/project', projectApp)
    .route('/worktree', worktreeApp)
    .route('/auth', authApp)
    .route('/shortcuts', shortcutsApp)
    .route('/config', configApp)
    .route('/image', imageApp)
}

export type AppType = ReturnType<typeof buildApp>
