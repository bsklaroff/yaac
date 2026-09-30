/**
 * Typed Hono API client for the server HTTP API, built on the shared
 * `createApiClient` (@yaac/shared/api-core) so the browser SPA and the CLI
 * share one error contract. Route methods infer their request bodies, params,
 * and response shapes from the server's `AppType`.
 *
 * Same-origin (dev: the Vite proxy; prod: the server serves the SPA). There
 * is no credential to carry: the server identifies the caller from the
 * request itself (loopback, or tailscale serve's identity headers). A non-2xx response rejects with a shared `ServerError` (thrown by the
 * client's fetch), so call sites never check `res.ok`; a successful call
 * resolves directly to its parsed body (no `.then((r) => r.json())`).
 */
import { createApiClient, createRawApiClient, type FetchLike } from '@yaac/shared/api-core'

/**
 * Fetch used by the API client. hono hands us a relative path (the client's
 * origin is empty), so requests resolve against the page origin; we only add
 * the JSON Accept header the server expects.
 */
const sameOriginFetch: FetchLike = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  return fetch(input, { ...init, headers })
}

export const api = createApiClient('', sameOriginFetch)

/** The same routes without the throwing/unwrapping wrappers, for the one call
 *  whose error body carries more than a code: a file save refused against a
 *  newer version (see `saveWorkspaceFile`). */
export const rawApi = createRawApiClient('', sameOriginFetch)
