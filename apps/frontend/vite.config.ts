import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// Relative import (not @yaac/shared): Vite loads this config through esbuild,
// which would try to resolve a bare @yaac/* specifier against Node at
// config-load time. The rest of the frontend imports @yaac/shared normally.
import { DEFAULT_SERVER_PORT } from '../../packages/shared/src/server-port-default'

/**
 * The server prefers DEFAULT_SERVER_PORT (or its --port / YAAC_SERVER_PORT
 * override), incrementing to the next free port if it's busy, and records the
 * actual port in the lock file. The dev server proxies API + WS traffic
 * there, so we read the port at startup. Override with YAAC_SERVER_PORT, or
 * YAAC_DATA_DIR to relocate the lock. If no server is running yet, fall back
 * to the default port and warn — start the server, then restart
 * `pnpm frontend:dev`.
 */
function resolveServerPort(): number {
  const fromEnv = process.env.YAAC_SERVER_PORT
  if (fromEnv) return Number(fromEnv)
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const lockPath = path.join(dataDir, '.server.lock')
  try {
    const lock: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    const port = (lock as { port?: unknown }).port
    if (typeof port === 'number') return port
  } catch {
    // fall through to the warning below
  }
  console.warn(
    `[vite] no server lock at ${lockPath}; proxying to :${DEFAULT_SERVER_PORT}. `
    + 'Start it with `yaac server start`, then restart the dev server.',
  )
  return DEFAULT_SERVER_PORT
}

const serverPort = resolveServerPort()
const target = `http://127.0.0.1:${serverPort}`

// Bare-path API surface proxied to the server (see webapp-frontend.md:
// the slice keeps the existing paths rather than a /v1 prefix).
const apiPrefixes = ['/session', '/project', '/tool', '/auth', '/shortcuts', '/prewarm', '/health', '/image']

interface ProxyEntry {
  target: string
  changeOrigin: boolean
  ws?: boolean
}

const proxy: Record<string, ProxyEntry> = {}
for (const p of apiPrefixes) proxy[p] = { target, changeOrigin: true }
proxy['/events'] = { target, changeOrigin: true, ws: true }
proxy['/pty'] = { target, changeOrigin: true, ws: true }

export default defineConfig({
  root: 'src',
  plugins: [react(), tailwindcss()],
  resolve: {
    // `#…` subpath imports: Vite doesn't fall through the package.json
    // `imports` array (./src/*.ts then ./src/*.tsx), so alias `#` to src and
    // let Vite's own extension probing find .ts / .tsx. tsc/eslint use the
    // package.json imports map instead (no `#*` tsconfig paths).
    alias: [{ find: /^#(.*)$/, replacement: path.resolve(__dirname, 'src') + '/$1' }],
  },
  server: {
    port: 1420,
    strictPort: true,
    proxy,
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist/frontend'),
    emptyOutDir: true,
  },
})
