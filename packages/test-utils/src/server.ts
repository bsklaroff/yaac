import { serve, type ServerType } from '@hono/node-server'
import { buildApp } from '@yaac/server/main/server'

export interface InProcessServer {
  baseUrl: string
  stop: () => Promise<void>
}

/**
 * Boot an in-process server on a real 127.0.0.1 socket, found by the
 * client through `YAAC_SERVER_URL` rather than a lock file. Startup's
 * `attachConvergence` is not run, so there are no informer caches or
 * watchers.
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
