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
import { mamaRelayApp, workspaceApp } from '#routes/workspaces'
import { authApp } from '#routes/auth'
import { shortcutsApp } from '#routes/shortcuts'
import { configApp } from '#routes/config'
import { imageApp } from '#routes/images'
import { hasWorkspaceDriver, workspaceDriver } from '#drivers/driver'
import { PACKAGE_ROOT } from '@yaac/shared/paths'
import type { AccessMode, Whoami } from '@yaac/shared/types'
import { listUsers } from '#db'

export interface ServerAppDeps {
  buildId: string
  /**
   * Whether startup init (DB open and first-boot migrations) has finished,
   * reported on `/health` as `ready`. The port and lock exist before init,
   * so `yaac server start` waits on this rather than bare liveness.
   * Defaults to always-ready for tests that never open the DB.
   */
  isReady?: () => boolean
  /**
   * The access mode startup settled, or why it refused the start (reported
   * on `/health` as `refused`); undefined until then. Defaults to `local`
   * for tests that never open the DB.
   */
  access?: () => AccessMode | { refused: string } | undefined
}

/**
 * Build the Hono app. A factory so tests can drive `app.fetch` directly
 * without binding a socket.
 */
export function buildApp(deps: ServerAppDeps) {
  const isReady = deps.isReady ?? (() => true)
  const access = deps.access ?? (() => 'local')
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
  app.use('*', identify(access))

  app.onError(errorResponse)

  app.notFound((c) => c.json(
    { error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } },
    404,
  ))

  // Serve the built SPA when present (production). In dev, Vite serves it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  app.route('/api', apiRoutes(isReady, access, deps.buildId))
  return app
}

function errorResponse(err: Error, c: Context): Response {
  const { status, body } = toErrorBody(err)
  return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
}

/**
 * The app on the k8s driver's yaac-mama relay listener: that one route,
 * which authenticates the egress proxy itself, so none of the API's gates
 * apply (docs/workspace-egress.md).
 */
export function buildMamaRelayApp(authenticate: (bearer: string) => Promise<boolean>) {
  const app = new Hono()
  app.use('*', requestLogger())
  app.onError(errorResponse)
  app.route('/api/workspace', mamaRelayApp(authenticate))
  return app
}

/**
 * Every HTTP route, mounted under `/api` (like server-run's WebSocket
 * routes) so none collide with SPA paths. `AppType` is this sub-app;
 * `createApiClient` adds the prefix.
 */
function apiRoutes(
  isReady: () => boolean,
  access: () => AccessMode | { refused: string } | undefined,
  buildId: string,
) {
  return new Hono<IdentityEnv>()
    .get('/health', (c) => {
      const a = access()
      return c.json({
        ok: true,
        buildId,
        ready: isReady(),
        // `yaac server start` compares a running server's mode with the one
        // it was asked for, and prints a refused start's reason.
        access: typeof a === 'string' ? a : null,
        refused: typeof a === 'object' ? a.refused : undefined,
        // The driver, or null before one is registered. On /health because
        // `yaac cluster …` needs it before identifying, to know what THIS
        // server runs.
        driver: hasWorkspaceDriver() ? workspaceDriver().kind : null,
      })
    })
    // The SPA's bootstrap and the clients' "will this server accept me"
    // probe. A tailnet install lists only tailnet users: its built-in user
    // has no login until a switch from local gives it one.
    .get('/whoami', async (c) => {
      const users = (await listUsers()).filter((u) => access() === 'local' || u.login !== null)
      return c.json({ ...c.get('principal'), users } satisfies Whoami)
    })
    .route('/project', projectApp)
    .route('/workspace', workspaceApp)
    .route('/auth', authApp)
    .route('/shortcuts', shortcutsApp)
    .route('/config', configApp)
    .route('/image', imageApp)
}

export type AppType = ReturnType<typeof apiRoutes>
