import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#domain/projects/local-config', () => ({
  addPortForwardToProjectConfig: vi.fn(() => Promise.resolve({})),
}))

import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { addPortForwardToProjectConfig } from '#domain/projects/local-config'
import { dismissWorkspacePort, forwardWorkspacePort } from '#domain/workspaces/forward-port'
import { ServerError } from '@yaac/shared/errors'
import type { PortMapping } from '@yaac/shared/types'

const mockPersist = vi.mocked(addPortForwardToProjectConfig)
const mockUnforwarded = vi.fn<(workspaceId: string) => Promise<number[]>>()
const mockForwardPort = vi.fn<
  (
    t: { workspaceId: string; projectSlug: string; jobName: string },
    p: number,
    o: { fanOutToProject: boolean },
  ) => Promise<PortMapping>
>()

const HANDLE = handleFixture({
  workspaceId: 'sid-1', projectSlug: 'proj', jobName: 'yaac-proj-sid-1', state: 'running',
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPersist.mockResolvedValue({})
  mockUnforwarded.mockResolvedValue([8090])
  mockForwardPort.mockResolvedValue({ containerPort: 8090, hostPort: 8090 })
  installFakeWorkspaceDriver({
    find: () => Promise.resolve(HANDLE),
    unforwardedPorts: mockUnforwarded,
    forwardPort: mockForwardPort,
  })
})

describe('forwardWorkspacePort', () => {
  it('forwards live only, writing no config, when persist is false', async () => {
    const mapping = await forwardWorkspacePort('sid-1', 8090, { persist: false })

    expect(mapping).toEqual({ containerPort: 8090, hostPort: 8090 })
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockForwardPort).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectSlug: 'proj', jobName: 'yaac-proj-sid-1' },
      8090,
      { fanOutToProject: false },
    )
  })

  it('persists before forwarding, and a persisted port implies the fan-out', async () => {
    const order: string[] = []
    mockPersist.mockImplementation(() => {
      order.push('config')
      return Promise.resolve({})
    })
    mockForwardPort.mockImplementation(() => {
      order.push('runtime')
      return Promise.resolve({ containerPort: 8090, hostPort: 8090 })
    })

    await forwardWorkspacePort('sid-1', 8090, { persist: true })

    expect(order).toEqual(['config', 'runtime'])
    expect(mockPersist).toHaveBeenCalledExactlyOnceWith('proj', 8090)
    expect(mockForwardPort).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectSlug: 'proj', jobName: 'yaac-proj-sid-1' },
      8090,
      { fanOutToProject: true },
    )
  })

  it('refuses an ineligible port BEFORE writing any config', async () => {
    // A refused forward must not leave the port in the project config, where
    // every future workspace would inherit it.
    mockUnforwarded.mockResolvedValue([3000])

    await expect(forwardWorkspacePort('sid-1', 8090, { persist: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('refuses an ineligible port with persist off too', async () => {
    mockUnforwarded.mockResolvedValue([])

    await expect(forwardWorkspacePort('sid-1', 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('forwards nothing when the config write fails', async () => {
    mockPersist.mockRejectedValue(new ServerError('VALIDATION', 'bad config'))

    await expect(forwardWorkspacePort('sid-1', 8090, { persist: true })).rejects.toThrow('bad config')
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('surfaces the runtime refusing a port that left the set in between', async () => {
    // The eligibility check is not a reservation; the runtime re-checks.
    mockForwardPort.mockRejectedValue(new ServerError('CONFLICT', 'not an unforwarded listener'))

    await expect(forwardWorkspacePort('sid-1', 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
  })
})

describe('dismissWorkspacePort', () => {
  const mockDismiss = vi.fn<(workspaceId: string, port: number) => boolean>()

  beforeEach(() => {
    mockDismiss.mockReset().mockReturnValue(true)
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(HANDLE),
      dismissPort: mockDismiss,
    })
  })

  it('dismisses the resolved workspace’s port', async () => {
    await dismissWorkspacePort('sid-1', 8090)

    expect(mockDismiss).toHaveBeenCalledExactlyOnceWith('sid-1', 8090)
  })

  // Same refusal as forwardWorkspacePort: both act on one webapp row, so a
  // stale click gets the same error either way.
  it('refuses a port the runtime is not offering', async () => {
    mockDismiss.mockReturnValue(false)

    await expect(dismissWorkspacePort('sid-1', 8090))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(dismissWorkspacePort('sid-1', 8090))
      .rejects.toThrow(/not an unforwarded listener/)
  })

  it('never reaches the runtime for a workspace that is not running', async () => {
    installFakeWorkspaceDriver({
      find: () => Promise.resolve(undefined),
      dismissPort: mockDismiss,
    })

    await expect(dismissWorkspacePort('gone', 8090)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mockDismiss).not.toHaveBeenCalled()
  })

  it('writes no project config — dismissal is in-memory only', async () => {
    await dismissWorkspacePort('sid-1', 8090)

    expect(mockPersist).not.toHaveBeenCalled()
  })
})
