import { describe, it, expect, vi, afterEach } from 'vitest'
import { getSessionTerminals, closeSessionTerminal, nextShellName } from '@/frontend/lib/terminalsApi'
import type { SessionTerminalEntry } from '@/shared/types'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(json: unknown = [], status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(''),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('getSessionTerminals', () => {
  it('GETs the session terminals endpoint', async () => {
    const entries = [{ target: 'shell:shell', name: 'shell', kind: 'shell' }]
    const fetchMock = stub(entries)
    const result = await getSessionTerminals('abc-123')
    expect(fetchMock.mock.calls[0][0] as string).toBe('/session/abc-123/terminals')
    expect(result).toEqual(entries)
  })
})

describe('closeSessionTerminal', () => {
  it('POSTs the close endpoint with the target', async () => {
    const fetchMock = stub(null, 200)
    await closeSessionTerminal('abc-123', 'shell:shell-2')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/session/abc-123/terminals/close')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ target: 'shell:shell-2' })
  })
})

describe('nextShellName', () => {
  const shell = (name: string): SessionTerminalEntry => ({ target: `shell:${name}`, name, kind: 'shell' })

  it('fills the first free name', () => {
    expect(nextShellName([])).toBe('shell')
    expect(nextShellName([shell('shell')])).toBe('shell-2')
    expect(nextShellName([shell('shell'), shell('shell-2')])).toBe('shell-3')
    expect(nextShellName([{ target: 'window:@1', name: 'shell', kind: 'window' }])).toBe('shell')
  })
})
