import crypto from 'node:crypto'
import { serve, type ServerType } from '@hono/node-server'
import { buildApp } from '@yaac/server/main/server'
import { _resetHerdForTests, createInProcessHerd, setHerd } from '@yaac/server/herd'
import type { TokenStore } from '@yaac/server/http/token-store'

export interface InProcessServer {
  baseUrl: string
  secret: string
  stop: () => Promise<void>
}

/**
 * Boot an in-process server for tests. The server listens on a real
 * 127.0.0.1 socket so the CLI's HTTP client exercises the production
 * code path, but we skip the lock file entirely by pointing the client
 * at us via the `YAAC_SERVER_URL` + `YAAC_SERVER_SECRET` env vars.
 *
 * The server is attached to an in-process herd, as `yaac server run` would
 * attach it: the routes reach the cluster, the worktrees and the transcripts
 * only through that boundary, so one with no herd answers nothing
 * (docs/plans/layered-server.md). Nothing is converged — `lifecycle.attach` is
 * the server's own startup step and is deliberately not run here.
 */
export async function bootInProcessServer(
  opts: { tokens?: TokenStore } = {},
): Promise<InProcessServer> {
  const secret = crypto.randomBytes(32).toString('hex')
  setHerd(createInProcessHerd())
  const app = buildApp({ secret, buildId: 'test', tokens: opts.tokens })

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
  process.env.YAAC_SERVER_SECRET = secret

  return {
    baseUrl,
    secret,
    stop: async () => {
      delete process.env.YAAC_SERVER_URL
      delete process.env.YAAC_SERVER_SECRET
      _resetHerdForTests()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
