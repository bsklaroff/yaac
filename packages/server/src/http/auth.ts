import type { Context, MiddlewareHandler } from 'hono'
import { serverLog } from '#log'

// Bearer/cookie auth lives in `./web-auth` (one gate accepts either
// credential), and the Host/Origin/Sec-Fetch-Site guards with it. This
// module keeps the CORS preflight refusal and the request log.

/**
 * Browser `fetch` is not allowed to talk to the server cross-origin: refuse
 * the preflight outright, so a non-simple cross-origin request never reaches
 * a route. The `Origin` on an actual request is judged by `originHeaderCheck`.
 */
export function denyBrowserCors(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 405)
    return next()
  }
}

/** Log path + status + duration. Never log request/response bodies. */
export function requestLogger(): MiddlewareHandler {
  return async (c: Context, next) => {
    const t0 = Date.now()
    await next()
    const dur = Date.now() - t0
    serverLog(`[server] ${c.req.method} ${c.req.path} ${c.res.status} ${dur}ms`)
  }
}
