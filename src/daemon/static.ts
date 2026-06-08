import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Hono } from 'hono'

/**
 * CSP for the SPA shell. Loopback-only http daemon, so cookies can't be
 * `Secure`; the CSP is the main hardening on the HTML response.
 * `connect-src` allows ws/wss for the `/events` and future PTY sockets.
 * `style-src 'unsafe-inline'` is the one relaxation — Vite/React inject a
 * little inline style; tightening to hashes is a later polish pass.
 */
export const SPA_CSP =
  "default-src 'self'; "
  + "script-src 'self'; "
  + "style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; "
  + "connect-src 'self' ws: wss:; "
  + "base-uri 'self'; "
  + "frame-ancestors 'none'"

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

export function contentTypeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Serve the built SPA bundle from `frontendDir`:
 *   GET /            → index.html (CSP, no cache)
 *   GET /assets/...  → hashed assets (immutable, long cache)
 * Asset paths are confined to `frontendDir/assets` so a crafted
 * `..`-laden request can't escape the bundle.
 */
export function registerStaticRoutes(app: Hono, frontendDir: string): void {
  const indexPath = path.join(frontendDir, 'index.html')
  const assetsDir = path.join(frontendDir, 'assets')

  app.get('/', async (c) => {
    const html = await readFile(indexPath, 'utf8').catch(() => null)
    if (html === null) return c.notFound()
    c.header('Content-Type', 'text/html; charset=utf-8')
    c.header('Content-Security-Policy', SPA_CSP)
    c.header('Cache-Control', 'no-cache')
    return c.body(html)
  })

  app.get('/assets/*', async (c) => {
    const rel = c.req.path.slice('/assets/'.length)
    const abs = path.join(assetsDir, rel)
    if (!abs.startsWith(assetsDir + path.sep)) return c.notFound()
    const buf = await readFile(abs).catch(() => null)
    if (buf === null) return c.notFound()
    c.header('Content-Type', contentTypeFor(abs))
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    return c.body(buf)
  })
}
