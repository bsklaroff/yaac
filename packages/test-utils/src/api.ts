import { hc } from 'hono/client'
import type { buildApp, AppType } from '@yaac/server/main/server'
import type { SpawnedServer } from '#cli'

type ServerApp = ReturnType<typeof buildApp>

/**
 * Wrap an in-memory `buildApp(...)` instance as a raw typed Hono API client.
 * Injects the bearer header on every request and dispatches through
 * `app.fetch`, so no port is bound. Uses a loopback host so the server's
 * Host-header check accepts it (the real CLI likewise targets 127.0.0.1).
 *
 * Raw on purpose: unlike the app's `createApiClient`, this neither throws on
 * non-2xx nor unwraps the body, so contract tests can assert status codes and
 * read `res.json()` themselves.
 */
export function makeTestApiClient(app: ServerApp, secret = 'shh') {
  return hc<AppType>('http://127.0.0.1/', {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {})
      headers.set('authorization', `Bearer ${secret}`)
      const req = new Request(input as string | URL, { ...init, headers })
      return app.fetch(req)
    },
  })
}

/**
 * Raw typed Hono API client that speaks to a real spawned server subprocess
 * over HTTP. Mirrors `makeTestApiClient` (also raw) but issues real network
 * calls against `server.lock.port` with the server's bearer secret.
 */
export function makeServerApiClient(server: SpawnedServer) {
  return hc<AppType>(`http://127.0.0.1:${server.lock.port}/`, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {})
      headers.set('authorization', `Bearer ${server.lock.secret}`)
      return fetch(input as string | URL, { ...init, headers })
    },
  })
}
