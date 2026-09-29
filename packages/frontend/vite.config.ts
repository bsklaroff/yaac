import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// The package scripts load this config with `--configLoader runner`, whose
// resolver reads the shared package's `#…` imports map; the default `bundle`
// loader hands bare imports to raw Node, which cannot resolve them.
import { resolveServerTarget } from '@yaac/shared/server-api'

interface OutgoingLike { setHeader(name: string, value: string): void }
interface IncomingLike { headers: Record<string, string | string[] | undefined> }
interface ProxyLike { on(event: string, listener: (out: OutgoingLike, req: IncomingLike) => void): void }

/**
 * The dev server proxies API + WS traffic to the server every client
 * reaches: the selected origin in `server.json` (docs/server-selection.md),
 * or `YAAC_SERVER_URL` to point it elsewhere. Never the lock — under k8s
 * its port is the one the pod binds, which on the host is some unrelated
 * listener. Nothing selected refuses to start, with the message every
 * client prints; select or start a server, then restart the dev server.
 */
async function serverProxy() {
  const target = (await resolveServerTarget()).baseUrl
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
  // Every route the server answers, HTTP and WebSocket, is under /api.
  return { '/api': { ...sameOrigin, ws: true } }
}

export default defineConfig(async ({ command }) => ({
  root: 'src',
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
    // A build proxies nothing, so it needs no server.
    ...(command === 'serve' ? { proxy: await serverProxy() } : {}),
  },
  build: {
    // The package's own dist; the root build copies it into the publish
    // artifact (dist/frontend). Building straight into the root dist/ would
    // couple this build to tsup's clean:true ordering — a bare `tsup` after
    // a build would silently delete the webapp.
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
}))
