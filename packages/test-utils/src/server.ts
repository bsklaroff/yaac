import { serve, type ServerType } from '@hono/node-server'
import { buildApp } from '@yaac/server/main/server'

export interface InProcessServer {
  baseUrl: string
  stop: () => Promise<void>
}

/**
 * Boot an in-process server for tests. The server listens on a real
 * 127.0.0.1 socket so the CLI's HTTP client exercises the production
 * code path, but we skip the lock file entirely by pointing the client
 * at us via the `YAAC_SERVER_URL` env var.
 *
 * Nothing is converged — `attachConvergence` is the server's own startup
 * step and is deliberately not run here, so the routes answer from the
 * substrate and the disk directly, with no informer caches or watchers.
 */
export async function bootInProcessServer(): Promise<InProcessServer> {
  const app = buildApp({ buildId: 'test' })

  const { server, port } = await new Promise<{ server: ServerType; port: number }>(
    (resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    },
  )

  const baseUrl = `http://127.0.0.1:${port}`
  process.env.YAAC_SERVER_URL = baseUrl

  return {
    baseUrl,
    stop: async () => {
      delete process.env.YAAC_SERVER_URL
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
