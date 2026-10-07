import { createElement, type ReactElement } from 'react'
import { vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import { whoamiQuery } from '#lib/viewer'
import type { Whoami } from '@yaac/shared/types'

/**
 * A stub of the global `fetch`, which is where the SPA meets the server:
 * component tests answer the typed client's requests here rather than
 * mocking the modules that make them. Routes are keyed `'METHOD /api/path'`
 * (the query string is not part of the key). A route's reply is a JSON body,
 * a `Response`, or a function of the request returning either (or a promise
 * of one). Unrouted requests answer 404 NOT_FOUND, so a forgotten route
 * fails loudly. Undo with `vi.unstubAllGlobals()`.
 */

export interface FetchCall {
  method: string
  path: string
  query: URLSearchParams
  /** The parsed JSON body, if any. */
  body: unknown
}

type Reply = unknown

export interface FetchMock {
  /** Every request so far, in order. */
  calls: FetchCall[]
  /** The requests made to one route. */
  called: (route: string) => FetchCall[]
  /** Add or replace a route's reply. */
  route: (route: string, reply: Reply) => void
}

/** An error reply in the server's `{ error: { code, message } }` shape. */
export function serverError(code: string, message = code, status = 500): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function mockFetch(routes: Record<string, Reply> = {}): FetchMock {
  const table = new Map(Object.entries(routes))
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const text = typeof init?.body === 'string' ? init.body : ''
    const call: FetchCall = {
      method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) as unknown : undefined,
    }
    calls.push(call)
    const key = `${method} ${url.pathname}`
    if (!table.has(key)) return serverError('NOT_FOUND', `no route for ${key}`, 404)
    const entry = table.get(key)
    const reply: unknown = await (typeof entry === 'function' ? (entry as (c: FetchCall) => unknown)(call) : entry)
    if (reply instanceof Response) return reply.clone()
    if (reply === undefined) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } })
  })
  return {
    calls,
    called: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    route: (route, reply) => { table.set(route, reply) },
  }
}

/** The caller a test's components see: a `local` install's one user, who
 *  owns every fixture project (`owner: TEST_USER_ID`). */
export const TEST_USER_ID = 'u-me'
export const TEST_WHOAMI: Whoami = {
  kind: 'local', userId: TEST_USER_ID, users: [{ id: TEST_USER_ID, login: null, name: 'Me' }],
}

/** A query client configured like the app's (main.tsx): no retries, and no
 *  refetches the test did not cause. It already holds `whoami`, as the app's
 *  does by the time anything below the bootstrap renders; pass null to
 *  leave it for the test to answer. */
export function testQueryClient(whoami: Whoami | null = TEST_WHOAMI): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  })
  if (whoami) client.setQueryData(whoamiQuery.queryKey, whoami)
  return client
}

/** Render inside a fresh query client. */
export function renderWithClient(ui: ReactElement, client = testQueryClient()): RenderResult {
  return render(createElement(QueryClientProvider, { client }, ui))
}
