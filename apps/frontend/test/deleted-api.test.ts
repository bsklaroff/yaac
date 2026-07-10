import { describe, it, expect, vi, afterEach } from 'vitest'
import { getDeletedSessions } from '#lib/deletedApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('getDeletedSessions', () => {
  it('requests the project-scoped list-deleted endpoint with a limit', async () => {
    const entries = [{ sessionId: 'a', projectSlug: 'p', tool: 'claude', createdAt: '2026-01-01 00:00:00' }]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(entries),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await getDeletedSessions('my-project', 10)

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/session/list-deleted')
    expect(url).toContain('project=my-project')
    expect(url).toContain('limit=10')
    expect(result).toEqual(entries)
  })

  it('defaults the limit to 25', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await getDeletedSessions('proj')

    expect(fetchMock.mock.calls[0][0] as string).toContain('limit=25')
  })
})
