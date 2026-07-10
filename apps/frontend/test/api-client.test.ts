import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, ApiError } from '#lib/apiClient'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }): void {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch
}

describe('apiClient', () => {
  it('get parses JSON on a 2xx response', async () => {
    stubFetch({ ok: true, status: 200, json: () => Promise.resolve({ a: 1 }) })
    expect(await api.get<{ a: number }>('/x')).toEqual({ a: 1 })
  })

  it('throws ApiError(401) on 401', async () => {
    stubFetch({ ok: false, status: 401 })
    await expect(api.get('/x')).rejects.toMatchObject({ status: 401 })
  })

  it('throws ApiError on other non-2xx', async () => {
    stubFetch({ ok: false, status: 500, text: () => Promise.resolve('boom') })
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError)
  })

  it('returns undefined on 204 (no body)', async () => {
    stubFetch({ ok: true, status: 204 })
    expect(await api.post('/x', { hi: true })).toBeUndefined()
  })

  it('put sends a PUT and parses the JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ content: 'x' }) })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    expect(await api.put<{ content: string }>('/x', { content: 'x' })).toEqual({ content: 'x' })
    expect(fetchMock).toHaveBeenCalledWith('/x', expect.objectContaining({ method: 'PUT' }))
  })

  it('put sends a JSON body with the PUT method', async () => {
    stubFetch({ ok: true, status: 204 })
    expect(await api.put('/x', { hi: true })).toBeUndefined()
    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(call[0]).toBe('/x')
    expect(call[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ hi: true }) })
  })
})
