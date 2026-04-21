import { hc } from 'hono/client'
import type { buildApp, AppType } from '@/daemon/server'
import type { SpawnedDaemon } from '@test/helpers/cli'

type DaemonApp = ReturnType<typeof buildApp>

/**
 * Wrap an in-memory `buildApp(...)` instance as a typed Hono RPC client.
 * Injects the bearer header on every request and dispatches through
 * `app.fetch`, so no port is bound.
 */
export function makeTestRpcClient(app: DaemonApp, secret = 'shh') {
  return hc<AppType>('http://test.local/', {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {})
      headers.set('authorization', `Bearer ${secret}`)
      const req = new Request(input as string | URL, { ...init, headers })
      return app.fetch(req)
    },
  })
}

/**
 * Typed Hono RPC client that speaks to a real spawned daemon subprocess
 * over HTTP. Mirrors `makeTestRpcClient` but issues real network calls
 * against `daemon.lock.port` with the daemon's bearer secret.
 */
export function makeDaemonRpcClient(daemon: SpawnedDaemon) {
  return hc<AppType>(`http://127.0.0.1:${daemon.lock.port}/`, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {})
      headers.set('authorization', `Bearer ${daemon.lock.secret}`)
      return fetch(input as string | URL, { ...init, headers })
    },
  })
}
