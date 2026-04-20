import crypto from 'node:crypto'
import { serve, type ServerType } from '@hono/node-server'
import { buildApp } from '@/daemon/server'

export interface InProcessDaemon {
  baseUrl: string
  secret: string
  stop: () => Promise<void>
}

/**
 * Boot an in-process daemon for tests. The daemon listens on a real
 * 127.0.0.1 socket so the CLI's HTTP client exercises the production
 * code path, but we skip the lock file entirely by pointing the client
 * at us via the `YAAC_DAEMON_URL` + `YAAC_DAEMON_SECRET` env vars.
 *
 * The returned `stop()` shuts the server down and unsets the env vars.
 */
export async function bootInProcessDaemon(): Promise<InProcessDaemon> {
  const secret = crypto.randomBytes(32).toString('hex')
  const app = buildApp({ secret, buildId: 'test' })

  const { server, port } = await new Promise<{ server: ServerType; port: number }>(
    (resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    },
  )

  const baseUrl = `http://127.0.0.1:${port}`
  process.env.YAAC_DAEMON_URL = baseUrl
  process.env.YAAC_DAEMON_SECRET = secret

  return {
    baseUrl,
    secret,
    stop: async () => {
      delete process.env.YAAC_DAEMON_URL
      delete process.env.YAAC_DAEMON_SECRET
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
