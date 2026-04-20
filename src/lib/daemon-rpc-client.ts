import { hc } from 'hono/client'
import type { AppType } from '@/lib/daemon/server'
import { createDaemonFetch, type GetClientOptions } from '@/lib/daemon-client'

/**
 * Typed Hono RPC client for the daemon. Returns an `hc<AppType>(...)`
 * proxy whose route methods infer request bodies, params, and
 * response shapes directly from the server's route handlers.
 *
 * The underlying fetch is produced by `createDaemonFetch`, so spawn,
 * lock resolution, and AUTH_REQUIRED / BAD_BEARER retry logic are
 * shared with the legacy `getClient()`.
 *
 * Usage:
 *   const client = await getRpcClient()
 *   const res = await client.project.list.$get()
 *   const projects = await unwrap(res)  // typed ProjectListEntry[]
 */
export async function getRpcClient(opts: GetClientOptions = {}) {
  const daemonFetch = await createDaemonFetch(opts)

  // `hc` bakes the base URL into every request. We discard it via
  // `extractPathAndSearch` and route to the live daemon's port, so
  // this host is just a placeholder.
  return hc<AppType>('http://daemon.local/', {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      return daemonFetch(url, init)
    },
  })
}

