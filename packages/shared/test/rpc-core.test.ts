import { describe, it, expect, vi } from 'vitest'
import { throwingFetch, createRpcClient, createRawRpcClient } from '#rpc-core'
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

describe('createRpcClient / createRawRpcClient', () => {
  it('createRpcClient rejects with a ServerError on a non-2xx route response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse('{"error":{"code":"VALIDATION","message":"bad"}}', 400)),
    )
    const client = createRpcClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    await expect(client.tool.get.$get()).rejects.toMatchObject({ code: 'VALIDATION', message: 'bad' })
  })

  it('createRpcClient resolves the success body', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse('{"tool":"codex"}')))
    const client = createRpcClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    expect(await client.tool.get.$get().then((r) => r.json())).toEqual({ tool: 'codex' })
  })

  it('createRawRpcClient returns the raw non-2xx response for the caller to inspect', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse('{"error":{"code":"VALIDATION","message":"bad"}}', 400)),
    )
    const client = createRawRpcClient('http://server.local/', fetchImpl as unknown as typeof fetch)
    const res = await client.tool.get.$get()
    expect(res.status).toBe(400)
  })
})
