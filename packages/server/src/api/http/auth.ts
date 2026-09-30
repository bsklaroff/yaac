import type { MiddlewareHandler } from 'hono'
import { serverLog } from '#log'
import type { IdentityEnv } from './web-auth'

// CORS preflight refusal and the request log. The identity gate and the
// Host/Origin/Sec-Fetch-Site guards live in `./web-auth`.

/**
 * Refuse every CORS preflight, so a non-simple cross-origin browser request
 * never reaches a route. The `Origin` of an actual request is checked by
 * `originHeaderCheck`.
 */
export function denyBrowserCors(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 405)
    return next()
  }
}

/**
 * Log method, path, status, duration and the tailnet user, as an audit trail.
 * Never log request or response bodies.
 */
export function requestLogger(): MiddlewareHandler<IdentityEnv> {
  return async (c, next) => {
    const t0 = Date.now()
    await next()
    const dur = Date.now() - t0
    const who = c.get('principal') as IdentityEnv['Variables']['principal'] | undefined
    const as = who?.kind === 'tailnet' ? ` ${who.login}` : ''
    serverLog(`[server] ${c.req.method} ${c.req.path} ${c.res.status} ${dur}ms${as}`)
  }
}
