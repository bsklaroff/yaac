import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  renameWorkspaceGroup,
  setWorkspaceGroup,
  setWorkspaceGroupPinned,
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

describe('createWorkspaceGroup', () => {
  it('POSTs the name with its founding workspace and returns the new id', async () => {
    const fetchMock = stub({ groupId: 'g-1' }, 200)
    expect(await createWorkspaceGroup('proj', 'sid-1', 'release')).toEqual({ groupId: 'g-1' })
    expect(sent(fetchMock)).toEqual([
      '/api/workspace/group/create',
      { projectSlug: 'proj', workspaceId: 'sid-1', name: 'release' },
    ])
  })
})

describe('renameWorkspaceGroup', () => {
  it('POSTs the new name', async () => {
    const fetchMock = stub()
    await renameWorkspaceGroup('proj', 'g-1', 'shipping')
    expect(sent(fetchMock)).toEqual([
      '/api/workspace/group/rename',
      { projectSlug: 'proj', groupId: 'g-1', name: 'shipping' },
    ])
  })
})

describe('setWorkspaceGroupPinned', () => {
  it('POSTs the pin both ways', async () => {
    const pin = stub()
    await setWorkspaceGroupPinned('proj', 'g-1', true)
    expect(sent(pin)).toEqual([
      '/api/workspace/group/set-pinned',
      { projectSlug: 'proj', groupId: 'g-1', pinned: true },
    ])

    const unpin = stub()
    await setWorkspaceGroupPinned('proj', 'g-1', false)
    expect(sent(unpin)[1]).toEqual({ projectSlug: 'proj', groupId: 'g-1', pinned: false })
  })
})

describe('deleteWorkspaceGroup', () => {
  it('POSTs the group id', async () => {
    const fetchMock = stub()
    await deleteWorkspaceGroup('proj', 'g-1')
    expect(sent(fetchMock)).toEqual([
      '/api/workspace/group/delete',
      { projectSlug: 'proj', groupId: 'g-1' },
    ])
  })
})

describe('setWorkspaceGroup', () => {
  it('POSTs a move into a group, and null for a move back to the default list', async () => {
    const into = stub()
    await setWorkspaceGroup('proj', 'sid-1', 'g-1')
    expect(sent(into)).toEqual([
      '/api/workspace/set-group',
      { projectSlug: 'proj', workspaceId: 'sid-1', groupId: 'g-1' },
    ])

    const out = stub()
    await setWorkspaceGroup('proj', 'sid-1', null)
    expect(sent(out)[1]).toEqual({ projectSlug: 'proj', workspaceId: 'sid-1', groupId: null })
  })
})
