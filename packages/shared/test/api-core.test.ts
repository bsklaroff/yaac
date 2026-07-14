import { describe, it, expect, vi } from 'vitest'
import { throwingFetch, createApiClient, createRawApiClient } from '#api-core'
import { ServerError } from '#errors'

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

describe('throwingFetch', () => {
  it('passes a 2xx response through untouched (caller can still read the body)', async () => {
    const res = jsonResponse('{"tool":"claude"}')
    const out = await throwingFetch(() => Promise.resolve(res))('/x')
    expect(out).toBe(res)
    expect(res.bodyUsed).toBe(false)
    expect(await out.json()).toEqual({ tool: 'claude' })
  })

  it('throws a ServerError with the envelope code + message on a non-2xx', async () => {
    const wrapped = throwingFetch(() =>
      Promise.resolve(jsonResponse('{"error":{"code":"NOT_FOUND","message":"nope"}}', 404)),
    )
    await expect(wrapped('/x')).rejects.toBeInstanceOf(ServerError)
    await expect(wrapped('/x')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'nope', httpStatus: 404 })
  })

  it('degrades to INTERNAL naming the status when the error body is not JSON', async () => {
    const wrapped = throwingFetch(() => Promise.resolve(new Response('boom', { status: 502 })))
    await expect(wrapped('/x')).rejects.toMatchObject({ code: 'INTERNAL', message: 'server returned 502' })
  })
})

describe('createApiClient / createRawApiClient', () => {
  it('createApiClient rejects with a ServerError on a non-2xx route response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse('{"error":{"code":"VALIDATION","message":"bad"}}', 400)),
    )
    const client = createApiClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    await expect(client.tool.get.$get()).rejects.toMatchObject({ code: 'VALIDATION', message: 'bad' })
  })

  it('createApiClient resolves the parsed body directly on a JSON route (no .json() unwrap)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse('{"tool":"codex"}')))
    const client = createApiClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    expect(await client.tool.get.$get()).toEqual({ tool: 'codex' })
  })

  it('createApiClient resolves undefined for a 204 (no body to parse)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    const client = createApiClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    expect(await client.tool.get.$get()).toBeUndefined()
  })

  it('createApiClient hands back the raw Response for a non-JSON (streaming) body', async () => {
    // A route hono types as a stream/text format resolves to the live Response
    // (content-type is not application/json), so callers can read res.body.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('{"type":"result"}\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })),
    )
    const client = createApiClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    const res = await client.tool.get.$get()
    expect(res).toBeInstanceOf(Response)
    expect((res as unknown as Response).body).not.toBeNull()
  })

  it('createRawApiClient returns the raw non-2xx response for the caller to inspect', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse('{"error":{"code":"VALIDATION","message":"bad"}}', 400)),
    )
    const client = createRawApiClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    const res = await client.tool.get.$get()
    expect(res.status).toBe(400)
  })
})
