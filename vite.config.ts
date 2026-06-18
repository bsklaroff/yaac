import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { DEFAULT_DAEMON_PORT } from './src/shared/daemon-port'

/**
 * The daemon prefers DEFAULT_DAEMON_PORT (or its --port / YAAC_DAEMON_PORT
 * override), incrementing to the next free port if it's busy, and records the
 * actual port in the lock file. The dev server proxies API + WS traffic
 * there, so we read the port at startup. Override with YAAC_DAEMON_PORT, or
 * YAAC_DATA_DIR to relocate the lock. If no daemon is running yet, fall back
 * to the default port and warn — start the daemon, then restart
 * `pnpm frontend:dev`.
 */
function resolveDaemonPort(): number {
  const fromEnv = process.env.YAAC_DAEMON_PORT
  if (fromEnv) return Number(fromEnv)
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const lockPath = path.join(dataDir, '.daemon.lock')
  try {
    const lock: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    const port = (lock as { port?: unknown }).port
    if (typeof port === 'number') return port
  } catch {
    // fall through to the warning below
  }
  console.warn(
    `[vite] no daemon lock at ${lockPath}; proxying to :${DEFAULT_DAEMON_PORT}. `
    + 'Start it with `yaac daemon start`, then restart the dev server.',
  )
  return DEFAULT_DAEMON_PORT
}

const daemonPort = resolveDaemonPort()
const target = `http://127.0.0.1:${daemonPort}`

// Bare-path API surface proxied to the daemon (see webapp-frontend.md:
// the slice keeps the existing paths rather than a /v1 prefix).
const apiPrefixes = ['/session', '/project', '/tool', '/auth', '/prewarm', '/health']

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
  root: 'src/frontend',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    proxy,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/frontend'),
    emptyOutDir: true,
  },
})
