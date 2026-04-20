import { Hono } from 'hono'
import type { Context } from 'hono'
import { bearerAuth, denyBrowserCors, requestLogger } from '@/daemon/auth'
import { toErrorBody, rewriteZValidatorBody } from '@/daemon/errors'
import { projectApp } from '@/daemon/routes/project'
import { sessionApp } from '@/daemon/routes/session'
import { toolApp } from '@/daemon/routes/tool'
import { authApp } from '@/daemon/routes/auth'
import { readPrewarmSessions } from '@/lib/prewarm'

export interface DaemonAppDeps {
  secret: string
  buildId: string
}

/**
 * Build the hono app. Kept as a factory so tests can instantiate it
 * without actually binding a TCP socket (hono apps expose `fetch` which
 * can be driven with `new Request(...)` directly).
 */
export function buildApp(deps: DaemonAppDeps) {
  const app = new Hono()

  app.use('*', requestLogger())
  app.use('*', denyBrowserCors())
  app.use('*', bearerAuth(deps.secret))
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

  return app
    .get('/health', (c) => c.json({ ok: true, buildId: deps.buildId }))
    .get('/prewarm', async (c) => c.json(await readPrewarmSessions()))
    .route('/project', projectApp)
    .route('/session', sessionApp)
    .route('/tool', toolApp)
    .route('/auth', authApp)
}

export type AppType = ReturnType<typeof buildApp>
