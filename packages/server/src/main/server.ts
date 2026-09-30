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
import { mamaApp, workspaceApp } from '#routes/workspaces'
import { authApp } from '#routes/auth'
import { shortcutsApp } from '#routes/shortcuts'
import { configApp } from '#routes/config'
import { imageApp } from '#routes/images'
import { hasWorkspaceDriver, workspaceDriver } from '#drivers/driver'
import { PACKAGE_ROOT } from '@yaac/shared/paths'

export interface ServerAppDeps {
  buildId: string
  /**
   * Whether startup init (DB open and first-boot migrations) has finished,
   * reported on `/health` as `ready`. The port and lock exist before init,
   * so `yaac server start` waits on this rather than bare liveness.
   * Defaults to always-ready for tests that never open the DB.
   */
  isReady?: () => boolean
}

/**
 * Build the Hono app. A factory so tests can drive `app.fetch` directly
 * without binding a socket.
 */
export function buildApp(deps: ServerAppDeps) {
  const isReady = deps.isReady ?? (() => true)
  const app = new Hono<IdentityEnv>()

  app.use('*', requestLogger())
  // Lets a remote CLI detect version skew.
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('x-yaac-build-id', deps.buildId)
  })
  app.use('*', hostHeaderCheck())
  app.use('*', denyBrowserCors())
  // A browser's identity is ambient (loopback or tailnet), so reject
  // cross-site requests by Origin (must match the target origin exactly)
  // and Sec-Fetch-Site. Both are browser-set and apply to WS upgrades too.
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

  // Serve the built SPA when present (production). In dev, Vite serves it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  app.route('/api', apiRoutes(isReady, deps.buildId))
  return app
}

/**
 * Every HTTP route, mounted under `/api` (like server-run's WebSocket
 * routes) so none collide with SPA paths. `AppType` is this sub-app;
 * `createApiClient` adds the prefix.
 */
function apiRoutes(isReady: () => boolean, buildId: string) {
  return new Hono<IdentityEnv>()
    .get('/health', (c) => c.json({
      ok: true,
      buildId,
      ready: isReady(),
      // The driver, or null before one is registered. On /health because
      // `yaac cluster …` needs it before identifying, to know what THIS
      // server runs.
      driver: hasWorkspaceDriver() ? workspaceDriver().kind : null,
    }))
    // The SPA's bootstrap and the clients' "will this server accept me"
    // probe.
    .get('/whoami', (c) => c.json(c.get('principal')))
    .route('/project', projectApp)
    .route('/workspace', workspaceApp)
    // Legacy path an older staged `yaac-mama` still posts to
    // (docs/legacy-compat-shims.md).
    .route('/worktree', mamaApp)
    .route('/auth', authApp)
    .route('/shortcuts', shortcutsApp)
    .route('/config', configApp)
    .route('/image', imageApp)
}

export type AppType = ReturnType<typeof apiRoutes>
