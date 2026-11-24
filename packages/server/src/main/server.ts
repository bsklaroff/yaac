import path from 'node:path'
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { denyBrowserCors, requestLogger } from '#api/http/auth'
import { delegateGate, fetchSiteCheck, hostHeaderCheck, identify, originHeaderCheck, personOnly, type IdentityEnv } from '#api/http/web-auth'
import { registerStaticRoutes } from '#api/http/static'
import { toErrorBody } from '#api/http/errors'
import { projectApp } from '#routes/projects'
import { repoApp } from '#routes/repos'
import { workspaceApp } from '#routes/workspaces'
import { mamaApp, mamaRelayApp, type MamaDispatch } from '#api/mama/endpoint'
import { authApp } from '#routes/auth'
import { shortcutsApp } from '#routes/shortcuts'
import { configApp } from '#routes/config'
import { routineApp } from '#routes/routines'
import { volumeApp } from '#routes/volumes'
import { siteApp } from '#routes/sites'
import { workflowApp } from '#routes/workflows'
import { imageApp } from '#routes/images'
import { serverApp } from '#routes/server'
import { usersApp } from '#routes/users'
import { jsonBodyLimit, zv } from '#routes/validator'
import { submitFeedback } from '#domain/feedback'
import { workspaceDriver } from '#drivers/driver'
import { PACKAGE_ROOT } from '@yaac/shared/paths'
import { MAX_ATTACHMENT_BYTES } from '@yaac/shared/attachments'
import type { AccessMode, Delegate, Whoami } from '@yaac/shared/types'
import { listUsers } from '#db'
import { z } from 'zod'
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

  app.notFound(noRoute)

  // Serve the built SPA when present (production). In dev, Vite serves it.
  const frontendDir = path.join(PACKAGE_ROOT, 'frontend')
  if (existsSync(path.join(frontendDir, 'index.html'))) {
    registerStaticRoutes(app, frontendDir)
  }

  app.route('/api', apiRoutes(isReady, access, deps.buildId))
  app.route('/api/workspace', mamaApp(mamaDispatch(deps)))
  return app
}

/**
 * The API's HTTP routes for a delegate alone (docs/multi-user.md
 * "Authorization"), behind `delegateGate`, which admits only the delegate
 * `resolve` answers for a request. No route is public, `/api/health`
 * included; it serves no WebSocket route and no SPA, runs none of the
 * browser guards and never answers `local`. yaac-mama's commands reach the
 * routes through it in the server process.
 */
export function delegateApp(resolve: (request: Request) => Promise<Delegate | undefined>, deps: ServerAppDeps) {
  const app = new Hono<IdentityEnv>()
  app.use('*', requestLogger())
  app.onError(errorResponse)
  app.notFound(noRoute)
  app.use('*', delegateGate(resolve))
  app.route('/api', apiRoutes(deps.isReady ?? (() => true), deps.access ?? (() => 'local'), deps.buildId))
  return app
}

/** The answer for a path no route serves. */
function noRoute(c: Context): Response {
  return c.json({ error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } }, 404)
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
export function buildMamaRelayApp(authenticate: (bearer: string) => Promise<boolean>, deps: ServerAppDeps) {
  const app = new Hono()
  app.use('*', requestLogger())
  app.onError(errorResponse)
  app.route('/api/workspace', mamaRelayApp(authenticate, mamaDispatch(deps)))
  return app
}

/**
 * How yaac-mama's commands reach the routes as the calling workspace's
 * delegate: in memory, through one `delegateApp`, which knows each request's
 * delegate by the request itself, so nothing outside this process can claim
 * one.
 */
export function mamaDispatch(deps: ServerAppDeps): MamaDispatch {
  const delegates = new WeakMap<Request, Delegate>()
  const app = delegateApp((request) => Promise.resolve(delegates.get(request)), deps)
  return (delegate) => async (input, init) => {
    const request = new Request(input, init)
    delegates.set(request, delegate)
    return await app.fetch(request)
  }
}

/** A feedback body: its images base64-encoded, plus room for the words. */
const FEEDBACK_BODY_LIMIT = Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 64 * 1024

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
    .post(
      '/feedback',
      personOnly,
      jsonBodyLimit(FEEDBACK_BODY_LIMIT, 'the feedback\'s images are over the 5 MB limit'),
      zv('json', z.object({
        message: z.string().trim().min(1).max(10_000),
        images: z.array(z.object({ mimeType: z.string(), data: z.string() })).optional(),
        client: z.object({
          version: z.string().max(100).optional(),
          gitCommit: z.string().max(100).optional(),
          userAgent: z.string().max(1000),
          // A string rather than an enum, so a shell kind this server
          // predates still gets its report through.
          app: z.object({
            kind: z.string().max(20),
            version: z.string().max(100).optional(),
            build: z.string().max(100).optional(),
            gitCommit: z.string().max(100).optional(),
          }).optional(),
        }).optional(),
      })),
      async (c) => {
        return c.json(await submitFeedback(c.get('principal'), c.req.valid('json')))
      },
    )
    .route('/project', projectApp)
    .route('/repo', repoApp)
    .route('/workspace', workspaceApp)
    .route('/auth', authApp)
    .route('/shortcuts', shortcutsApp)
    .route('/config', configApp)
    .route('/routine', routineApp)
    .route('/volume', volumeApp)
    .route('/site', siteApp)
    .route('/workflow', workflowApp)
    .route('/image', imageApp)
    .route('/server', serverApp)
    .route('/users', usersApp)
}

export type AppType = ReturnType<typeof apiRoutes>
