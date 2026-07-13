import { describe, it, expect, vi, afterEach } from 'vitest'
import { rpc, unwrap, expectOk, ApiError } from '#lib/rpc'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Stub globalThis.fetch — the RPC client's sameOriginFetch calls straight
 *  through to it. `ok` is derived from the status. */
function stubFetch(over: {
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
} = {}): ReturnType<typeof vi.fn> {
  const status = over.status ?? 200
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: over.json ?? (() => Promise.resolve(undefined)),
    text: over.text ?? (() => Promise.resolve('')),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('rpc client', () => {
  it('sends same-origin credentials and a JSON Accept header', async () => {
    const fetchMock = stubFetch({ json: () => Promise.resolve({ tool: 'claude' }) })
    await unwrap(rpc.tool.get.$get())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/tool/get')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('accept')).toBe('application/json')
  })

  it('unwrap returns the JSON body on a 2xx response', async () => {
    stubFetch({ json: () => Promise.resolve({ tool: 'codex' }) })
    expect(await unwrap(rpc.tool.get.$get())).toEqual({ tool: 'codex' })
  })

  it('expectOk resolves on a 204', async () => {
    stubFetch({ status: 204 })
    await expect(expectOk(rpc.shortcuts.reset.$post())).resolves.toBeUndefined()
  })

  it('surfaces a 401 as ApiError(401)', async () => {
    stubFetch({ status: 401 })
    await expect(unwrap(rpc.tool.get.$get())).rejects.toMatchObject({ status: 401 })
  })

  it('throws ApiError carrying the server message on other non-2xx', async () => {
    stubFetch({ status: 500, text: () => Promise.resolve(JSON.stringify({ error: { message: 'boom' } })) })
    await expect(unwrap(rpc.tool.get.$get())).rejects.toThrow(/boom/)
    stubFetch({ status: 500, text: () => Promise.resolve(JSON.stringify({ error: { message: 'boom' } })) })
    await expect(unwrap(rpc.tool.get.$get())).rejects.toBeInstanceOf(ApiError)
  })

  it('ApiError carries the status code', () => {
    const err = new ApiError(404, 'nope')
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(404)
  })
})
