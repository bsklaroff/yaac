/**
 * Typed Hono client for the server HTTP API, built on the shared
 * `createApiClient` so the SPA and the CLI handle errors the same way. Route
 * types come from the server's `AppType`.
 *
 * Requests are same-origin (the Vite proxy in dev; the server serves the SPA
 * in prod) and carry no credential: the server identifies the caller from
 * the request (loopback, or tailscale serve's identity headers). A non-2xx
 * response rejects with a `ServerError`; a successful call resolves to its
 * parsed body.
 */
import { createApiClient, createRawApiClient, type FetchLike } from '@yaac/shared/api-core'

/** Resolves hono's relative paths against the page origin and adds the JSON
 *  Accept header the server expects. */
const sameOriginFetch: FetchLike = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  return fetch(input, { ...init, headers })
}

export const api = createApiClient('', sameOriginFetch)

/** The same routes without the throw-on-error wrapper, for the one call whose
 *  error body carries more than a code (`saveWorkspaceFile`'s conflict). */
export const rawApi = createRawApiClient('', sameOriginFetch)
