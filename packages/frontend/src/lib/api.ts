/**
 * Typed Hono API client for the server HTTP API, built on the shared
 * `createApiClient` (@yaac/shared/api-core) so the browser SPA and the CLI
 * share one error contract. Route methods infer their request bodies, params,
 * and response shapes from the server's `AppType`.
 *
 * Same-origin (dev: the Vite proxy; prod: the server serves the SPA), so the
 * browser sends the `yaac_session` cookie automatically — no token handling
 * here. A non-2xx response rejects with a shared `ServerError` (thrown by the
 * client's fetch), so call sites never check `res.ok`; a successful call
 * resolves directly to its parsed body (no `.then((r) => r.json())`).
 */
import { createApiClient, type FetchLike } from '@yaac/shared/api-core'

/**
 * Fetch used by the API client. hono hands us a relative path (the client's
 * base is '/'), so requests resolve against the page origin; we only add the
 * cookie credentials and JSON Accept header the server expects.
 */
const sameOriginFetch: FetchLike = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  return fetch(input, { ...init, credentials: 'same-origin', headers })
}

export const api = createApiClient('/', sameOriginFetch)
