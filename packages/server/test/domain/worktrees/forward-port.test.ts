import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('#domain/projects/local-config', () => ({
  addPortForwardToProjectConfig: vi.fn(() => Promise.resolve({})),
}))

import { handleFixture, installFakeWorktreeRuntime } from '@yaac/test-utils/fake-runtime'
import { addPortForwardToProjectConfig } from '#domain/projects/local-config'
import { forwardWorktreePort } from '#domain/worktrees/forward-port'
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
  installFakeWorktreeRuntime({
    find: () => Promise.resolve(HANDLE),
    unforwardedPorts: mockUnforwarded,
    forwardPort: mockForwardPort,
  })
})

describe('forwardWorktreePort', () => {
  it('forwards live only, writing no config, when persist is false', async () => {
    const mapping = await forwardWorktreePort('sid-1', 8090, { persist: false })

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

    await forwardWorktreePort('sid-1', 8090, { persist: true })

    expect(order).toEqual(['config', 'runtime'])
    expect(mockPersist).toHaveBeenCalledExactlyOnceWith('proj', 8090)
    expect(mockForwardPort).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: 'sid-1', projectSlug: 'proj', jobName: 'yaac-proj-sid-1' },
      8090,
      { fanOutToProject: true },
    )
  })

  it('refuses an ineligible port BEFORE writing any config', async () => {
    // The whole reason the eligibility read sits above the persist: a click
    // racing the surfaced list must not leave the port in the project config,
    // inherited by every future worktree, behind an error saying it failed.
    mockUnforwarded.mockResolvedValue([3000])

    await expect(forwardWorktreePort('sid-1', 8090, { persist: true }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('refuses an ineligible port with persist off too', async () => {
    mockUnforwarded.mockResolvedValue([])

    await expect(forwardWorktreePort('sid-1', 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('forwards nothing when the config write fails', async () => {
    mockPersist.mockRejectedValue(new ServerError('VALIDATION', 'bad config'))

    await expect(forwardWorktreePort('sid-1', 8090, { persist: true })).rejects.toThrow('bad config')
    expect(mockForwardPort).not.toHaveBeenCalled()
  })

  it('surfaces the runtime refusing a port that left the set in between', async () => {
    // The runtime re-checks and is the authority; the read above is a
    // question asked a moment earlier, not a reservation.
    mockForwardPort.mockRejectedValue(new ServerError('CONFLICT', 'not an unforwarded listener'))

    await expect(forwardWorktreePort('sid-1', 8090, { persist: false }))
      .rejects.toThrow(/not an unforwarded listener/)
  })
})
