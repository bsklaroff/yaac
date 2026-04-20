import { Hono } from 'hono'
import type { Context } from 'hono'
import { bearerAuth, denyBrowserCors, requestLogger } from '@/lib/daemon/auth'
import { toErrorBody } from '@/lib/daemon/errors'
import { registerHealthRoutes } from '@/lib/daemon/routes/health'
import { registerProjectRoutes } from '@/lib/daemon/routes/project'

export interface DaemonAppDeps {
  secret: string
  version: string
}

/**
 * Build the hono app. Kept as a factory so tests can instantiate it
 * without actually binding a TCP socket (hono apps expose `fetch` which
 * can be driven with `new Request(...)` directly).
 */
export function buildApp(deps: DaemonAppDeps): Hono {
  const app = new Hono()

  app.use('*', requestLogger())
  app.use('*', denyBrowserCors())
  app.use('*', bearerAuth(deps.secret))

  app.onError((err: Error, c: Context) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400 | 401 | 404 | 409 | 500 | 503)
  })

  registerHealthRoutes(app, deps)
  registerProjectRoutes(app)

  app.notFound((c) => c.json(
    { error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}` } },
    404,
  ))

  return app
}
