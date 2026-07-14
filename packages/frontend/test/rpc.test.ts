import { describe, it, expect, vi, afterEach } from 'vitest'
import { rpc } from '#lib/rpc'
import { ServerError } from '@yaac/shared/errors'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Stub globalThis.fetch — the client's sameOriginFetch calls straight through
 *  to it. `ok` is derived from the status; `clone` returns the same stub so the
 *  throwing wrapper can read an error body. */
function stubFetch(over: {
  status?: number
  json?: () => Promise<unknown>
} = {}): ReturnType<typeof vi.fn> {
  const status = over.status ?? 200
  const res = {
    ok: status < 400,
    status,
    json: over.json ?? (() => Promise.resolve(undefined)),
    text: () => Promise.resolve(''),
    clone() { return this },
  }
  const fetchMock = vi.fn().mockResolvedValue(res)
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('frontend rpc client', () => {
  it('sends same-origin credentials and a JSON Accept header', async () => {
    const fetchMock = stubFetch({ json: () => Promise.resolve({ tool: 'claude' }) })
    await rpc.tool.get.$get().then((r) => r.json())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/tool/get')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('accept')).toBe('application/json')
  })

  it('resolves the JSON body on a 2xx response', async () => {
    stubFetch({ json: () => Promise.resolve({ tool: 'codex' }) })
    expect(await rpc.tool.get.$get().then((r) => r.json())).toEqual({ tool: 'codex' })
  })

  it('rejects with a ServerError carrying the server code + message on non-2xx', async () => {
    const body = { error: { code: 'INTERNAL', message: 'boom' } }
    stubFetch({ status: 500, json: () => Promise.resolve(body) })
    await expect(rpc.tool.get.$get()).rejects.toBeInstanceOf(ServerError)
    stubFetch({ status: 500, json: () => Promise.resolve(body) })
    await expect(rpc.tool.get.$get()).rejects.toMatchObject({ code: 'INTERNAL', message: 'boom' })
  })
})
