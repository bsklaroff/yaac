import path from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { denyBrowserCors, requestLogger } from '#api/http/auth'
import { fetchSiteCheck, hostHeaderCheck, identify, originHeaderCheck, type IdentityEnv } from '#api/http/web-auth'
import { registerStaticRoutes } from '#api/http/static'
import { toErrorBody } from '#api/http/errors'
import { projectApp } from '#routes/projects'
import { mamaRelayApp, workspaceApp } from '#routes/workspaces'
import { authApp } from '#routes/auth'
import { shortcutsApp } from '#routes/shortcuts'
import { configApp } from '#routes/config'
import { routineApp } from '#routes/routines'
import { imageApp } from '#routes/images'
import { serverApp } from '#routes/server'
import { workspaceDriver } from '#drivers/driver'
import { PACKAGE_ROOT } from '@yaac/shared/paths'
import type { AccessMode, Whoami } from '@yaac/shared/types'
import { listUsers } from '#db'
import { errorText, serverLog } from '#lib/log'

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

/** The wire form of a thrown error. An unexpected one is logged with its
 *  cause, which the response's message leaves out, unless it is the abort
 *  of a route that follows its request's signal and the client hung up. */
function errorResponse(err: Error, c: Context): Response {
  const { status, body } = toErrorBody(err)
  const abandoned = err.name === 'AbortError' && c.req.raw.signal.aborted
  if (status === 500 && !abandoned) serverLog(`[server] ${c.req.method} ${c.req.path} failed: ${errorText(err)}`)
  return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
}

/**
 * The app on the k8s driver's yaac-mama relay listener: the routes a
 * workspace calls (yaac-mama and a hosted remote), which authenticate the
 * egress proxy themselves, so none of the API's gates apply
 * (docs/workspace-egress.md).
 */
export function buildMamaRelayApp(authenticate: (bearer: string) => Promise<boolean>) {
  const app = new Hono()
  app.use('*', requestLogger())
  app.onError(errorResponse)
  app.route('/api/workspace', mamaRelayApp(authenticate))
  return app
}

/**
 * The fetch handler on a driver's probe listener (`WorkspaceDriver.probePort`):
 * `GET /api/health` answered by `app`, and 404 for anything else, since the
 * peers this port admits must reach nothing that takes an identity.
 */
export function probeFetch(app: { fetch: (req: Request) => Response | Promise<Response> }) {
  return (req: Request): Response | Promise<Response> =>
    req.method === 'GET' && new URL(req.url).pathname === '/api/health'
      ? app.fetch(req)
      : new Response(null, { status: 404 })
}

/**
 * Every HTTP route, mounted under `/api` (like the WebSocket routes,
 * `#api/ws-routes`) so none collide with SPA paths. `AppType` is this sub-app;
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
        // On /health because `yaac cluster …` needs it before identifying,
        // to know what THIS server runs.
        driver: workspaceDriver().kind,
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
    .route('/routine', routineApp)
    .route('/image', imageApp)
    .route('/server', serverApp)
}

export type AppType = ReturnType<typeof apiRoutes>
