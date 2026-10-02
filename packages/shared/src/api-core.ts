/**
 * Builds the typed Hono API client used by both the CLI (`server-api.ts`)
 * and the SPA (same-origin fetch), so both share one error contract:
 *  - Any non-2xx response throws a `ServerError` (`throwingFetch`).
 *  - A JSON route resolves to its parsed body, a 204 to `undefined`, and a
 *    streaming route to the raw `Response` (`unwrapClient`).
 *
 * Browser-safe: no node built-ins.
 */
import { hc } from 'hono/client'
import type { ClientResponse } from 'hono/client'
import { ServerError, type ServerErrorBody } from '#errors'
import type { AppType } from '#server-app-type'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Wrap a transport so any non-2xx response rejects with a `ServerError`
 * built from the server's `{ error: { code, message } }` body, or an
 * `INTERNAL` error naming the status if the body is not that. Successful
 * responses pass through unread.
 */
export function throwingFetch(inner: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init)
    if (res.ok) return res
    const body = await res.clone().json().catch(() => null) as ServerErrorBody | null
    throw new ServerError(
      body?.error.code ?? 'INTERNAL',
      body?.error.message ?? `server returned ${res.status}`,
    )
  }
}

/**
 * JSON → parsed body, 204 → `undefined`, anything else (the NDJSON
 * streaming routes) → the raw `Response` for `consumeNdjsonStream`.
 */
async function unwrapResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const contentType = res.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? res.json() : res
}

/** Client methods whose result is unwrapped; others (`$url`, `$path`) are not. */
const REQUEST_METHODS = new Set(['$get', '$post', '$put', '$delete', '$patch'])

/**
 * The client type with each `json`-format route's method returning
 * `Promise<Data>`. Other routes keep their `ClientResponse` type.
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
 * Wrap a hono `hc` client so request methods resolve through
 * `unwrapResponse`. `hc` is a chain of callable proxies, so this wraps each
 * node in a proxy of its own and intercepts calls on request methods.
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
 * Build the typed Hono API client for the server's `/api` at `origin`
 * (empty for the page's own origin) over the given transport.
 */
export function createApiClient(origin: string, fetch: FetchLike) {
  return unwrapClient(hc<AppType>(`${origin}/api`, { fetch: throwingFetch(fetch) }))
}

/**
 * The WebSocket URL of a server route: `path` on `origin` with the scheme
 * swapped to match (`https:` to `wss:`, else `ws:`) and each defined param
 * set. A TLS origin must get `wss:`, or the upgrade goes out in the clear.
 */
export function wsUrl(
  origin: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(path, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * The typed client without throwing or unwrapping, for tests that assert
 * on raw status codes.
 */
export function createRawApiClient(origin: string, fetch?: FetchLike) {
  return hc<AppType>(`${origin}/api`, { fetch })
}
