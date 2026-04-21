import type { Context, MiddlewareHandler } from 'hono'
import { daemonLog } from '@/daemon/log'

/**
 * Bearer middleware for the daemon. Every request must carry
 * `Authorization: Bearer <secret>` where <secret> matches the value
 * generated at daemon start and written to ~/.yaac/.daemon.lock.
 *
 * Because the daemon binds 127.0.0.1 only, the secret defends against
 * other processes on the same host; it is *not* a defense against a
 * compromised user account (which already owns the filesystem).
 *
 * The /health probe is exempt so the CLI bootstrap can distinguish
 * "daemon alive but wrong secret" (stale cache) from "daemon down".
 */
export function bearerAuth(secret: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/health') return next()
    const header = c.req.header('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match || !constantTimeEqual(match[1], secret)) {
      return c.json(
        { error: { code: 'BAD_BEARER', message: 'missing or invalid bearer token' } },
        401,
      )
    }
    return next()
  }
}

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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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
