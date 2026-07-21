import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// Resolved at config-load time: Vite externalizes bare imports to their real
// .ts paths and Node loads them via type stripping — needs Node >= 22.18.
import { DEFAULT_SERVER_PORT } from '@yaac/shared/server-port-default'
import {
  SERVER_LOCK_FILENAME,
  isLockLive,
  parseServerLock,
} from '@yaac/shared/server-lock-file'

/**
 * The server prefers DEFAULT_SERVER_PORT (or its --port / YAAC_SERVER_PORT
 * override), incrementing to the next free port if it's busy, and records the
 * actual port in the lock file. The dev server proxies API + WS traffic
 * there, so we read the port at startup — sharing the lock's shape and
 * liveness rules with the CLI via the dependency-free server-lock-file
 * module, so a stale lock falls back instead of proxying to a dead port.
 * Override with YAAC_SERVER_PORT, or YAAC_DATA_DIR to relocate the lock. If
 * no live server is found, fall back to the default port and warn — start
 * the server, then restart `pnpm frontend:dev`.
 */
async function resolveServerPort(): Promise<number> {
  const fromEnv = process.env.YAAC_SERVER_PORT
  if (fromEnv) return Number(fromEnv)
  const dataDir = process.env.YAAC_DATA_DIR ?? path.join(os.homedir(), '.yaac')
  const lockPath = path.join(dataDir, SERVER_LOCK_FILENAME)
  let raw: string | null = null
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    // no lock file — warn below
  }
  const lock = raw === null ? null : parseServerLock(raw)
  if (lock && await isLockLive(lock)) return lock.port
  console.warn(
    `[vite] no live server lock at ${lockPath}; proxying to :${DEFAULT_SERVER_PORT}. `
    + 'Start it with `yaac server start`, then restart the dev server.',
  )
  return DEFAULT_SERVER_PORT
}

const serverPort = await resolveServerPort()
const target = `http://127.0.0.1:${serverPort}`

// Bare-path API surface proxied to the server: the slice keeps the
// existing paths rather than a /v1 prefix.
const apiPrefixes = ['/session', '/project', '/tool', '/auth', '/shortcuts', '/prewarm', '/health', '/image', '/cluster']

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
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
