import { describe, it, expect, vi, afterEach } from 'vitest'
import { CHANGES_TARGET, isChangesTarget, getSessionChanges } from '#lib/changesApi'
import type { SessionChanges } from '@yaac/shared/types'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(json: unknown, status = 200): ReturnType<typeof vi.fn> {
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

describe('isChangesTarget', () => {
  it('matches only the single changes target', () => {
    expect(isChangesTarget(CHANGES_TARGET)).toBe(true)
    expect(isChangesTarget('agent')).toBe(false)
    expect(isChangesTarget('preview')).toBe(false)
  })
})

describe('getSessionChanges', () => {
  it('GETs the session changes endpoint and returns the body', async () => {
    const changes: SessionChanges = { base: 'abc123', files: [], diff: '', truncated: false }
    const fetchMock = stub(changes)
    const result = await getSessionChanges('abc-123')
    expect(fetchMock.mock.calls[0][0] as string).toBe('/session/abc-123/changes')
    expect(result).toEqual(changes)
  })
})
