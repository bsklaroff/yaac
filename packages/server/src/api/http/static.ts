import { createHash } from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Env, Hono } from 'hono'

/**
 * CSP for the SPA shell, the main hardening on the HTML response.
 * `connect-src` allows ws/wss for the WebSocket routes. `style-src
 * 'unsafe-inline'` is needed because Vite/React inject some inline style.
 * Inline <script> bodies in index.html (the pre-paint theme init) are allowed
 * by hash, computed from the served html so the policy always matches it.
 */
export function spaCsp(html: string): string {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => ` 'sha256-${createHash('sha256').update(body).digest('base64')}'`)
    .join('')
  return "default-src 'self'; "
    + `script-src 'self'${hashes}; `
    + "style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; "
    + "connect-src 'self' ws: wss:; "
    + "base-uri 'self'; "
    + "frame-ancestors 'none'"
}

/**
 * Serve the built SPA bundle from `frontendDir`:
 *   GET /            → index.html (CSP, no cache)
 *   GET /assets/...  → hashed assets (immutable, long cache)
 * `serveStatic` refuses `..` paths, so a request can't escape the bundle.
 */
export function registerStaticRoutes<E extends Env>(app: Hono<E>, frontendDir: string): void {
  const indexPath = path.join(frontendDir, 'index.html')

  app.get('/', async (c) => {
    const html = await readFile(indexPath, 'utf8').catch(() => null)
    if (html === null) return c.notFound()
    c.header('Content-Type', 'text/html; charset=utf-8')
    c.header('Content-Security-Policy', spaCsp(html))
    c.header('Cache-Control', 'no-cache')
    return c.body(html)
  })

  // Set after the fact: serveStatic's `onFound` runs once the response is
  // built, too late to add a header.
  app.get('/assets/*', async (c, next) => {
    await next()
    if (c.res.ok) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  }, serveStatic({ root: frontendDir }))
}
