import crypto from 'node:crypto'
import { serve, type ServerType } from '@hono/node-server'
import { buildApp } from '@/lib/daemon/server'
import { daemonLockPath, isLockLive, readLock, removeLock, writeLock } from '@/lib/daemon/lock'
import { ensureDataDir } from '@/lib/project/paths'

export interface DaemonStartOptions {
  port?: number
  version: string
}

/**
 * Entry point for `yaac daemon`.
 *
 * - If another daemon is already live, print its handshake and exit 0
 *   (idempotent start).
 * - Otherwise bind 127.0.0.1:<port-or-ephemeral>, write the lock, serve
 *   until SIGTERM / SIGINT, then unlink the lock and exit.
 */
export async function runDaemon(opts: DaemonStartOptions): Promise<void> {
  await ensureDataDir()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    console.error(`[daemon] already running pid=${existing.pid} port=${existing.port}`)
    return
  }

  const secret = crypto.randomBytes(32).toString('hex')
  const app = buildApp({ secret, version: opts.version })

  const { server, port } = await new Promise<{ server: ServerType; port: number }>(
    (resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: '127.0.0.1' }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    },
  )

  await writeLock({ pid: process.pid, port, secret, startedAt: Date.now() })
  console.error(`[daemon] listening on 127.0.0.1:${port} lock=${daemonLockPath()}`)

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[daemon] ${signal} — shutting down`)
    // @hono/node-server wraps a Node http.Server; close() refuses new
    // connections, drains in-flight requests, then fires the callback.
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeLock()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
