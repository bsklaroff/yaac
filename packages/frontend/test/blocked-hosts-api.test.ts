import { describe, it, expect, vi, afterEach } from 'vitest'
import { allowBlockedHost } from '#lib/blockedHostsApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(status = 204): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    status,
    json: () => Promise.resolve(undefined),
    text: () => Promise.resolve(''),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('allowBlockedHost', () => {
  it('POSTs the allow-host endpoint with the host and persist:true', async () => {
    const fetchMock = stub()
    await allowBlockedHost('abc-123', 'evil.example.com', { persist: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/worktree/abc-123/allow-host')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ host: 'evil.example.com', persist: true })
  })

  it('sends persist:false for a session-only allow', async () => {
    const fetchMock = stub()
    await allowBlockedHost('abc-123', 'x.com', { persist: false })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ host: 'x.com', persist: false })
  })
})
