/**
 * Typed Hono RPC client for the server HTTP API. Route methods infer their
 * request bodies, params, and response shapes directly from the server's route
 * handlers (`@yaac/server`'s `AppType`, reached via `@yaac/shared` so the
 * frontend depends only on shared).
 *
 * Same-origin (dev: the Vite proxy; prod: the server serves the SPA), so the
 * browser sends the `yaac_session` cookie automatically — no token handling
 * here. The `unwrap` / `expectOk` helpers apply the shared error contract:
 * throw on non-2xx, surface a 401 as a typed error so the app can drop back to
 * the connect splash.
 */
import { hc } from 'hono/client'
import type { ClientResponse } from 'hono/client'
import type { AppType } from '@yaac/shared/server-app-type'

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Fetch used by the RPC client. hono hands us a relative path (the client's
 * base is '/'), so requests resolve against the page origin; we only add the
 * cookie credentials and JSON Accept header the server expects.
 */
function sameOriginFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  return fetch(input, { ...init, credentials: 'same-origin', headers })
}

export const rpc = hc<AppType>('/', { fetch: sameOriginFetch })

/** Pull the server's `{ error: { message } }` out of a failed response. */
async function errorMessage(res: ClientResponse<unknown>): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `request failed: ${res.status}`
  try {
    const body = JSON.parse(text) as { error?: { message?: string } }
    return body.error?.message ?? text
  } catch {
    return text
  }
}

/** Shared error contract: 401 → typed unauthenticated error (drives the connect
 *  splash); any other non-2xx → ApiError carrying the server's message. */
async function throwIfNotOk(res: ClientResponse<unknown>): Promise<void> {
  if (res.status === 401) throw new ApiError(401, 'unauthenticated')
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res))
}

// A route's response type is a union of a success member plus any typed error
// members — every `zv`-validated route adds a `{ error }` 400. hono gives error
// responses a literal `ok: false` while a success response keeps `ok: boolean`,
// so dropping the `ok: false` members leaves the success response, and its body
// is what `unwrap` resolves to (mirroring hono's own `if (res.ok)` narrowing).
type SuccessResponse<R> = R extends { ok: false } ? never : R
type SuccessBody<R> = SuccessResponse<R> extends ClientResponse<infer T> ? T : never

/**
 * Await an RPC call and return its success JSON body. Use for endpoints whose
 * response the caller consumes.
 */
export async function unwrap<R extends ClientResponse<unknown>>(call: Promise<R>): Promise<SuccessBody<R>> {
  const res = await call
  await throwIfNotOk(res)
  return res.json() as Promise<SuccessBody<R>>
}

/**
 * Await an RPC call for its status alone — 204s and endpoints whose body the
 * caller ignores — applying the same error contract.
 */
export async function expectOk(call: Promise<ClientResponse<unknown>>): Promise<void> {
  await throwIfNotOk(await call)
}
