import { describe, it, expect, vi, afterEach } from 'vitest'
import { requestUsageRefresh } from '#lib/usageApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('requestUsageRefresh', () => {
  it('POSTs the usage-refresh nudge endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 204, json: () => Promise.resolve(undefined), text: () => Promise.resolve(''),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await requestUsageRefresh()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/auth/claude/usage/refresh')
    expect(init.method).toBe('POST')
  })
})
