import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#domain/projects/local-config', () => ({
  addAllowedHostToProjectConfig: vi.fn(() => Promise.resolve({})),
}))

import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { addAllowedHostToProjectConfig } from '#domain/projects/local-config'
import { allowWorkspaceHost } from '#domain/workspaces/allow-host'
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
  installFakeWorkspaceDriver({
    find: () => Promise.resolve(HANDLE),
    allowHost: mockAllowHost,
  })
})

describe('allowWorkspaceHost', () => {
  it('widens live only, writing no config, when persist is false', async () => {
    await allowWorkspaceHost('sid-1', 'h.com', { persist: false })

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

    await allowWorkspaceHost('sid-1', 'h.com', { persist: true })

    // The config write comes first, so a failure there leaves the live
    // allowlist unchanged too.
    expect(order).toEqual(['config', 'runtime'])
    expect(mockPersist).toHaveBeenCalledExactlyOnceWith('proj', 'h.com')
    expect(mockAllowHost).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectSlug: 'proj' }, 'h.com', { fanOutToProject: true },
    )
  })

  it('widens nothing when the config write fails', async () => {
    mockPersist.mockRejectedValue(new ServerError('VALIDATION', 'bad config'))

    await expect(allowWorkspaceHost('sid-1', 'h.com', { persist: true })).rejects.toThrow('bad config')
    expect(mockAllowHost).not.toHaveBeenCalled()
  })

  it('refuses a workspace that is not running, before touching config', async () => {
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(handleFixture({ workspaceId: 'sid-1', state: 'stopped' })),
      allowHost: mockAllowHost,
    })

    await expect(allowWorkspaceHost('sid-1', 'h.com', { persist: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockAllowHost).not.toHaveBeenCalled()
  })
})
