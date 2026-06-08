import type { Context, MiddlewareHandler } from 'hono'
import { daemonLog } from '@/daemon/log'

// Bearer/cookie auth now lives in `@/daemon/web-auth` (one gate accepts
// either credential). This module keeps the CORS guard and request log.

/**
 * Browser `fetch` is not allowed to talk to the daemon. Refuse preflight
 * and deny the `Origin` header on actual requests.
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
    daemonLog(`[daemon] ${c.req.method} ${c.req.path} ${c.res.status} ${dur}ms`)
  }
}
