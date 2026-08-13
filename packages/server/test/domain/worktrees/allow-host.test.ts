import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#domain/projects/local-config', () => ({
  addAllowedHostToProjectConfig: vi.fn(() => Promise.resolve({})),
}))

import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { addAllowedHostToProjectConfig } from '#domain/projects/local-config'
import { allowWorktreeHost } from '#domain/worktrees/allow-host'
import { ServerError } from '@yaac/shared/errors'

const mockPersist = vi.mocked(addAllowedHostToProjectConfig)
const mockAllowHost = vi.fn<
  (t: { workspaceId: string; projectSlug: string }, h: string, o: { fanOutToProject: boolean }) => Promise<void>
>()

const HANDLE = handleFixture({
  workspaceId: 'sid-1', projectSlug: 'proj', jobName: 'yaac-proj-sid-1', state: 'running',
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPersist.mockResolvedValue({})
  mockAllowHost.mockResolvedValue()
  installFakeWorktreeDriver({
    find: () => Promise.resolve(HANDLE),
    allowHost: mockAllowHost,
  })
})

describe('allowWorktreeHost', () => {
  it('widens live only, writing no config, when persist is false', async () => {
    await allowWorktreeHost('sid-1', 'h.com', { persist: false })

    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockAllowHost).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectSlug: 'proj' }, 'h.com', { fanOutToProject: false },
    )
  })

  it('persists before widening, and a persisted host implies the fan-out', async () => {
    const order: string[] = []
    mockPersist.mockImplementation(() => {
      order.push('config')
      return Promise.resolve({})
    })
    mockAllowHost.mockImplementation(() => {
      order.push('runtime')
      return Promise.resolve()
    })

    await allowWorktreeHost('sid-1', 'h.com', { persist: true })

    // The config write comes first: a failure there must leave nothing
    // widened anywhere, rather than a live widen with no record of it.
    expect(order).toEqual(['config', 'runtime'])
    expect(mockPersist).toHaveBeenCalledExactlyOnceWith('proj', 'h.com')
    expect(mockAllowHost).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectSlug: 'proj' }, 'h.com', { fanOutToProject: true },
    )
  })

  it('widens nothing when the config write fails', async () => {
    mockPersist.mockRejectedValue(new ServerError('VALIDATION', 'bad config'))

    await expect(allowWorktreeHost('sid-1', 'h.com', { persist: true })).rejects.toThrow('bad config')
    expect(mockAllowHost).not.toHaveBeenCalled()
  })

  it('refuses a worktree that is not running, before touching config', async () => {
    installFakeWorktreeDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'sid-1', state: 'stopped' })),
      allowHost: mockAllowHost,
    })

    await expect(allowWorktreeHost('sid-1', 'h.com', { persist: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockAllowHost).not.toHaveBeenCalled()
  })
})
