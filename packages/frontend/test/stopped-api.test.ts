import { describe, it, expect, vi, afterEach } from 'vitest'
import { getStoppedWorktrees } from '#lib/stoppedApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** A non-2xx fetch result carrying the shared error envelope, which the RPC
 *  client turns into a thrown ServerError. `clone` returns itself so the
 *  client can read the body. */
function errorStub(status: number, error: { code: string; message: string }): typeof fetch {
  const res = {
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
    text: () => Promise.resolve(JSON.stringify({ error })),
    clone() { return this },
  }
  return vi.fn().mockResolvedValue(res) as unknown as typeof fetch
}

describe('getStoppedWorktrees', () => {
  it('requests the project-scoped list-deleted endpoint with a limit', async () => {
    const entries = [{ worktreeId: 'a', projectSlug: 'p', tool: 'claude', createdAt: '2026-01-01 00:00:00' }]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(entries),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await getStoppedWorktrees('my-project', 10)

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/worktree/list-stopped')
    expect(url).toContain('project=my-project')
    expect(url).toContain('limit=10')
    expect(result).toEqual(entries)
  })

  it('defaults the limit to 100', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve([]) })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await getStoppedWorktrees('proj')

    expect(fetchMock.mock.calls[0][0] as string).toContain('limit=100')
  })

  it('degrades to an empty list when the server lacks the route (404)', async () => {
    globalThis.fetch = errorStub(404, { code: 'NOT_FOUND', message: 'no route' })

    expect(await getStoppedWorktrees('proj')).toEqual([])
  })

  it('still throws on non-404 errors', async () => {
    globalThis.fetch = errorStub(500, { code: 'INTERNAL', message: 'boom' })

    await expect(getStoppedWorktrees('proj')).rejects.toMatchObject({ code: 'INTERNAL', httpStatus: 500 })
  })
})
