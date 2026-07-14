/**
 * The one place a Hono API client is built. Both the CLI (via `server-api.ts`,
 * over the bearer/lock transport) and the browser SPA (over a same-origin
 * cookie fetch) call `createApiClient`, so they share a single error contract
 * and the same "unwrap the body for me" ergonomics instead of each
 * re-implementing them.
 *
 * Two behaviours live here, both so call sites stay boilerplate-free:
 *  - Errors: `throwingFetch` turns any non-2xx into a thrown `ServerError`
 *    (read from the shared `{ error: { code, message } }` envelope), so callers
 *    never check `res.ok`.
 *  - Bodies: the returned client auto-unwraps — a JSON route resolves to its
 *    parsed body (no `.then((r) => r.json())`), a 204 to `undefined`, and a
 *    streaming route (hono types it as a non-`json` format) to the raw
 *    `Response`, so `consumeNdjsonStream` can still read `res.body`.
 *
 * Browser-safe: only `hono/client` and the pure `#errors` taxonomy (no node
 * built-ins), so the frontend depends on it through `@yaac/shared`.
 */
import { hc } from 'hono/client'
import type { ClientResponse } from 'hono/client'
import { ServerError, type ServerErrorBody } from '#errors'
import type { AppType } from '#server-app-type'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Wrap a transport so any non-2xx response rejects with a `ServerError`
 * carrying the server's `{ error: { code, message } }`. Successful responses
 * pass through untouched — the body is never read here, so the unwrapping
 * layer still sees a live body. A missing or non-JSON error body degrades to
 * an `INTERNAL` error naming the status.
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
 * Read a successful response into the value call sites actually want. JSON
 * routes (the overwhelming majority) resolve to their parsed body; a 204 to
 * `undefined`; anything else — the NDJSON streaming routes hono types as a
 * non-`json` format — to the raw `Response`, so the caller can consume
 * `res.body` (see `consumeNdjsonStream`).
 */
async function unwrapResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const contentType = res.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? res.json() : res
}

/** Request verbs whose result carries a body worth unwrapping. `$url`/`$path`
 *  (URL builders) and any other segment call pass through untouched. */
const REQUEST_METHODS = new Set(['$get', '$post', '$put', '$delete', '$patch'])

/**
 * Recursively transform a client type so every request method resolves to its
 * unwrapped body. A `json`-format route becomes `(...args) => Promise<Data>`; a
 * streaming/text route keeps its `Promise<ClientResponse<…>>` (the caller needs
 * the raw `Response`). `$url`/`$path` and nested route nodes map through.
 */
export type UnwrappedClient<T> =
  T extends (...args: infer A) => Promise<ClientResponse<infer Data, infer _Status, infer Format>>
    ? [Format] extends ['json']
      ? (...args: A) => Promise<Data>
      : T
    : T extends (...args: never[]) => unknown
      ? T
      : { [K in keyof T]: UnwrappedClient<T[K]> }

/**
 * Wrap a hono `hc` client so request methods resolve to unwrapped bodies (see
 * `unwrapResponse`). hono builds each node as a callable proxy — properties
 * chain the route path, a call issues the request — so we mirror it: chain
 * `get`s, and when a call lands on a `$get`/`$post`/… segment, pipe its result
 * through `unwrapResponse`.
 */
function unwrapClient<T extends object>(client: T): UnwrappedClient<T> {
  const wrap = (node: unknown, lastKey: string | null): unknown => {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) {
      return node
    }
    return new Proxy(node, {
      get: (target, key) => wrap(Reflect.get(target, key), typeof key === 'string' ? key : null),
      apply: (target, thisArg, args) => {
        const result = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args)
        return lastKey !== null && REQUEST_METHODS.has(lastKey)
          ? (result as Promise<Response>).then(unwrapResponse)
          : result
      },
    })
  }
  return wrap(client, null) as UnwrappedClient<T>
}

/**
 * Build the typed Hono API client. `base` is the origin hono bakes into every
 * request URL; `fetch` is the transport (cookie same-origin in the browser,
 * bearer/lock resolution in the CLI). Non-2xx throws (see `throwingFetch`); a
 * successful call resolves to the unwrapped body (see `unwrapClient`).
 */
export function createApiClient(base: string, fetch: FetchLike) {
  return unwrapClient(hc<AppType>(base, { fetch: throwingFetch(fetch) }))
}

/**
 * Same typed client without the throwing/unwrapping wrappers, for callers that
 * need to inspect a raw non-2xx `Response` (HTTP-contract tests asserting
 * status codes). Application code should use `createApiClient`.
 */
export function createRawApiClient(base: string, fetch: FetchLike) {
  return hc<AppType>(base, { fetch })
}
