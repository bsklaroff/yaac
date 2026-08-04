import { describe, it, expect, vi, afterEach } from 'vitest'
import { setWorktreeBackground } from '#lib/createSession'

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

describe('setWorktreeBackground', () => {
  it('POSTs the set-background endpoint with the pin', async () => {
    const fetchMock = stub()
    await setWorktreeBackground('proj', 'sid-1', true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/worktree/set-background')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      projectSlug: 'proj', worktreeId: 'sid-1', background: true,
    })
  })

  it('sends background:false for an unpin', async () => {
    const fetchMock = stub()
    await setWorktreeBackground('proj', 'sid-1', false)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      projectSlug: 'proj', worktreeId: 'sid-1', background: false,
    })
  })
})
