import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// The package scripts load this config with `--configLoader runner`, whose
// resolver reads the shared package's `#…` imports map; the default `bundle`
// loader hands bare imports to raw Node, which cannot resolve them.
import { DEFAULT_SERVER_PORT } from '@yaac/shared/server-port'
import { readLock, serverLockPath } from '@yaac/shared/lock'
import { isLockLive } from '@yaac/shared/server-lock-file'

/**
 * The server prefers DEFAULT_SERVER_PORT (or its --port / YAAC_SERVER_PORT
 * override), incrementing to the next free port if it's busy, and records the
 * actual port in the lock file. The dev server proxies API + WS traffic
 * there, so we read the port at startup through the CLI's own lock reader,
 * so a stale lock falls back instead of proxying to a dead port. Override
 * with YAAC_SERVER_PORT. If no live server is found, fall back to the
 * default port and warn — start the server, then restart `pnpm frontend:dev`.
 */
async function resolveServerPort(): Promise<number> {
  const fromEnv = process.env.YAAC_SERVER_PORT
  if (fromEnv) return Number(fromEnv)
  const lock = await readLock()
  if (lock && await isLockLive(lock)) return lock.port
  console.warn(
    `[vite] no live server lock at ${serverLockPath()}; proxying to :${DEFAULT_SERVER_PORT}. `
    + 'Start it with `yaac server start`, then restart the dev server.',
  )
  return DEFAULT_SERVER_PORT
}

const serverPort = await resolveServerPort()
const target = `http://127.0.0.1:${serverPort}`

// Bare-path API surface proxied to the server: the slice keeps the
// existing paths rather than a /v1 prefix.
const apiPrefixes = ['/session', '/project', '/auth', '/shortcuts', '/prewarm', '/health', '/whoami', '/image', '/cluster']

interface OutgoingLike { setHeader(name: string, value: string): void }
interface IncomingLike { headers: Record<string, string | string[] | undefined> }
interface ProxyLike { on(event: string, listener: (out: OutgoingLike, req: IncomingLike) => void): void }

interface ProxyEntry {
  target: string
  changeOrigin: boolean
  configure: (proxy: ProxyLike) => void
  ws?: boolean
}

// `changeOrigin` rewrites Host to the server's; Origin has to follow it,
// because the server admits only a request whose Origin is the origin it
// was sent to (`isAllowedOrigin`). Only this dev page's own Origin is
// rewritten: anything else — a forwarded dev server on another port — goes
// through as sent and is refused, as it would be without the proxy.
const sameOrigin = {
  target,
  changeOrigin: true,
  configure: (proxy: ProxyLike) => {
    for (const event of ['proxyReq', 'proxyReqWs']) {
      proxy.on(event, (out, req) => {
        if (req.headers.origin === `http://${String(req.headers.host)}`) out.setHeader('origin', target)
      })
    }
  },
}
const proxy: Record<string, ProxyEntry> = {}
for (const p of apiPrefixes) proxy[p] = sameOrigin
proxy['/events'] = { ...sameOrigin, ws: true }
proxy['/pty'] = { ...sameOrigin, ws: true }
// The chat pane's transport, alongside the terminal's — without it a `tui`
// worktree works in dev and an `acp` one silently never connects.
proxy['/acp'] = { ...sameOrigin, ws: true }

export default defineConfig({
  root: 'src',
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
    proxy,
  },
  build: {
    // The package's own dist; the root build copies it into the publish
    // artifact (dist/frontend). Building straight into the root dist/ would
    // couple this build to tsup's clean:true ordering — a bare `tsup` after
    // a build would silently delete the webapp.
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
})
