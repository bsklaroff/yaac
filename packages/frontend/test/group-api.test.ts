import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createWorktreeGroup,
  deleteWorktreeGroup,
  renameWorktreeGroup,
  setWorktreeGroup,
  setWorktreeGroupPinned,
} from '#lib/groupApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(body: unknown = undefined, status = 204): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(''),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const sent = (fetchMock: ReturnType<typeof vi.fn>): [string, unknown] => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(init.method).toBe('POST')
  return [url, JSON.parse(init.body as string)]
}

describe('createWorktreeGroup', () => {
  it('POSTs the name with its founding worktree and returns the new id', async () => {
    const fetchMock = stub({ groupId: 'g-1' }, 200)
    expect(await createWorktreeGroup('proj', 'sid-1', 'release')).toEqual({ groupId: 'g-1' })
    expect(sent(fetchMock)).toEqual([
      '/worktree/group/create',
      { projectSlug: 'proj', worktreeId: 'sid-1', name: 'release' },
    ])
  })
})

describe('renameWorktreeGroup', () => {
  it('POSTs the new name', async () => {
    const fetchMock = stub()
    await renameWorktreeGroup('proj', 'g-1', 'shipping')
    expect(sent(fetchMock)).toEqual([
      '/worktree/group/rename',
      { projectSlug: 'proj', groupId: 'g-1', name: 'shipping' },
    ])
  })
})

describe('setWorktreeGroupPinned', () => {
  it('POSTs the pin both ways', async () => {
    const pin = stub()
    await setWorktreeGroupPinned('proj', 'g-1', true)
    expect(sent(pin)).toEqual([
      '/worktree/group/set-pinned',
      { projectSlug: 'proj', groupId: 'g-1', pinned: true },
    ])

    const unpin = stub()
    await setWorktreeGroupPinned('proj', 'g-1', false)
    expect(sent(unpin)[1]).toEqual({ projectSlug: 'proj', groupId: 'g-1', pinned: false })
  })
})

describe('deleteWorktreeGroup', () => {
  it('POSTs the group id', async () => {
    const fetchMock = stub()
    await deleteWorktreeGroup('proj', 'g-1')
    expect(sent(fetchMock)).toEqual([
      '/worktree/group/delete',
      { projectSlug: 'proj', groupId: 'g-1' },
    ])
  })
})

describe('setWorktreeGroup', () => {
  it('POSTs a move into a group, and null for a move back to the default list', async () => {
    const into = stub()
    await setWorktreeGroup('proj', 'sid-1', 'g-1')
    expect(sent(into)).toEqual([
      '/worktree/set-group',
      { projectSlug: 'proj', worktreeId: 'sid-1', groupId: 'g-1' },
    ])

    const out = stub()
    await setWorktreeGroup('proj', 'sid-1', null)
    expect(sent(out)[1]).toEqual({ projectSlug: 'proj', worktreeId: 'sid-1', groupId: null })
  })
})
