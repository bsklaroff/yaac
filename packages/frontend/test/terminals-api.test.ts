import { describe, it, expect, vi, afterEach } from 'vitest'
import { getSessionTerminals, createShellTerminal, killSessionTerminal } from '#lib/terminalsApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(json: unknown = [], status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(''),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('getSessionTerminals', () => {
  it('GETs the session terminals endpoint', async () => {
    const entries = [{ target: 'window:@2', name: 'shell' }]
    const fetchMock = stub(entries)
    const result = await getSessionTerminals('abc-123')
    expect(fetchMock.mock.calls[0][0] as string).toBe('/worktree/abc-123/terminals')
    expect(result).toEqual(entries)
  })
})

describe('createShellTerminal', () => {
  it('POSTs the terminals endpoint and returns the new entry', async () => {
    const entry = { target: 'window:@5', name: 'shell-2' }
    const fetchMock = stub(entry)
    const result = await createShellTerminal('abc-123')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/worktree/abc-123/terminals')
    expect(init.method).toBe('POST')
    expect(result).toEqual(entry)
  })
})

describe('killSessionTerminal', () => {
  it('POSTs the close endpoint with the target', async () => {
    const fetchMock = stub(null, 200)
    await killSessionTerminal('abc-123', 'window:@3')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/worktree/abc-123/terminals/close')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ target: 'window:@3' })
  })
})
