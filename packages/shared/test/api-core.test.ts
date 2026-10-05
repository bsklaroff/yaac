import { describe, it, expect, vi } from 'vitest'
import { throwingFetch, createApiClient, createRawApiClient, wsUrl } from '#api-core'
import { ServerError } from '#errors'

describe('throwingFetch', () => {
  it('passes a 2xx response through untouched (caller can still read the body)', async () => {
    const res = Response.json({ tool: 'claude' })
    const out = await throwingFetch(() => Promise.resolve(res))('/x')
    expect(out).toBe(res)
    expect(res.bodyUsed).toBe(false)
    expect(await out.json()).toEqual({ tool: 'claude' })
  })

  it('throws a ServerError with the envelope code + message on a non-2xx', async () => {
    const wrapped = throwingFetch(() =>
      Promise.resolve(Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 })),
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
      Promise.resolve(Response.json({ error: { code: 'VALIDATION', message: 'bad' } }, { status: 400 })),
    )
    const client = createApiClient('http://server.local', fetchImpl)
    await expect(client.auth.list.$get()).rejects.toMatchObject({ code: 'VALIDATION', message: 'bad' })
  })

  it('createApiClient resolves the parsed body directly on a JSON route (no .json() unwrap)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ tool: 'codex' })))
    const client = createApiClient('http://server.local', fetchImpl)
    expect(await client.auth.list.$get()).toEqual({ tool: 'codex' })
    // Routes are addressed unprefixed; the client puts them under /api.
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe('http://server.local/api/auth/list')
  })

  it('createApiClient resolves undefined for a 204 (no body to parse)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    const client = createApiClient('http://server.local', fetchImpl)
    expect(await client.auth.list.$get()).toBeUndefined()
  })

  it('createApiClient hands back the raw Response for a non-JSON (streaming) body', async () => {
    // A non-JSON route resolves to the live Response, so callers can read
    // res.body.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('{"type":"result"}\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })),
    )
    const client = createApiClient('http://server.local', fetchImpl)
    const res = await client.auth.list.$get()
    expect(res).toBeInstanceOf(Response)
    expect((res as unknown as Response).body).not.toBeNull()
  })

  it('createRawApiClient returns the raw non-2xx response for the caller to inspect', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: { code: 'VALIDATION', message: 'bad' } }, { status: 400 })),
    )
    const client = createRawApiClient('http://server.local', fetchImpl)
    const res = await client.auth.list.$get()
    expect(res.status).toBe(400)
  })
})

describe('wsUrl', () => {
  it('speaks wss to an https origin, and ws to an http one', () => {
    expect(wsUrl('https://srv.example.ts.net', '/api/forward/attach', { id: 'sess-1', port: 5173 }))
      .toBe('wss://srv.example.ts.net/api/forward/attach?id=sess-1&port=5173')
    expect(wsUrl('http://127.0.0.1:8787', '/api/events'))
      .toBe('ws://127.0.0.1:8787/api/events')
  })

  it('leaves out undefined params', () => {
    expect(wsUrl('http://127.0.0.1:8787', '/api/pty/attach', { id: 'abc', cols: undefined }))
      .toBe('ws://127.0.0.1:8787/api/pty/attach?id=abc')
  })
})
