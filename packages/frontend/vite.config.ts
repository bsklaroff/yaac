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
 * The dev server proxies API and WebSocket traffic to the selected server in
 * `server.json` (docs/server-selection.md), or to `YAAC_SERVER_URL`. It never
 * uses the lock file's port: under k8s that is the pod's port, not a host
 * one. With no server selected it refuses to start.
 */
async function serverProxy() {
  const target = (await resolveServerTarget()).baseUrl
  // `changeOrigin` rewrites Host to the server's, and Origin must match it
  // because the server only admits same-origin requests (`isAllowedOrigin`).
  // Only this dev page's own Origin is rewritten; any other Origin passes
  // through unchanged and is refused, as it would be without the proxy.
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
  return { '/api': { ...sameOrigin, ws: true } }
}

export default defineConfig(async ({ command }) => ({
  root: 'src',
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
    ...(command === 'serve' ? { proxy: await serverProxy() } : {}),
  },
  build: {
    // The root build copies this into dist/frontend. Building straight into
    // the root dist/ would let tsup's clean:true delete the webapp.
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
}))
