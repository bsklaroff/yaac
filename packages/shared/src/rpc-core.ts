/**
 * The one place a Hono RPC client is built. Both the CLI (via
 * `server-client.ts`, over the bearer/lock transport) and the browser SPA
 * (over a same-origin cookie fetch) call `createRpcClient`, so they share a
 * single error contract instead of each re-implementing one.
 *
 * The contract lives entirely in the injected fetch: `throwingFetch` turns any
 * non-2xx into a thrown `ServerError` (read from the shared
 * `{ error: { code, message } }` envelope). Callers therefore never check
 * `res.ok` or unwrap an error body — a call that resolves succeeded, and its
 * `res.json()` is the success body. This module is browser-safe: it pulls in
 * only `hono/client` and the pure `#errors` taxonomy (no node built-ins), so
 * the frontend can depend on it through `@yaac/shared`.
 */
import { hc } from 'hono/client'
import { ServerError, type ServerErrorBody } from '#errors'
import type { AppType } from '#server-app-type'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Wrap a transport so any non-2xx response rejects with a `ServerError`
 * carrying the server's `{ error: { code, message } }`. Successful responses
 * pass through untouched — the body is never read here, so the caller's
 * `res.json()` still works. A missing or non-JSON error body degrades to an
 * `INTERNAL` error naming the status.
 */
export function throwingFetch(inner: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init)
    if (res.ok) return res
    // Clone before reading: the body is consumed here only on the error path,
    // which discards the response anyway.
    const body = await res.clone().json().catch(() => null) as ServerErrorBody | null
    throw new ServerError(
      body?.error.code ?? 'INTERNAL',
      body?.error.message ?? `server returned ${res.status}`,
    )
  }
}

/**
 * Build the typed Hono RPC client. `base` is the origin hono bakes into every
 * request URL; `fetch` is the transport (cookie same-origin in the browser,
 * bearer/lock resolution in the CLI). Errors throw — see `throwingFetch`.
 */
export function createRpcClient(base: string, fetch: FetchLike) {
  return hc<AppType>(base, { fetch: throwingFetch(fetch) })
}

/**
 * Same typed client without the throwing wrapper, for callers that need to
 * inspect a raw non-2xx `Response` (HTTP-contract tests asserting status
 * codes). Application code should use `createRpcClient`.
 */
export function createRawRpcClient(base: string, fetch: FetchLike) {
  return hc<AppType>(base, { fetch })
}
