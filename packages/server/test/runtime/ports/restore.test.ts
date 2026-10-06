/**
 * `restoreAllWorkspaceForwarders`. Only the driver is mocked; candidate
 * selection and the status-bar refresh run for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PortMapping, YaacConfig } from '@yaac/shared/types'

vi.mock('#runtime/status/liveness', () => ({ isTmuxSessionAlive: vi.fn() }))

import { isTmuxSessionAlive } from '#runtime/status/liveness'
import { restoreAllWorkspaceForwarders } from '#runtime/ports/restore'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'

const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const projectConfig = vi.fn<(projectId: string) => Promise<YaacConfig | undefined>>()

const list = vi.fn<WorkspaceDriver['list']>()
const forwardedPorts = vi.fn<WorkspaceDriver['forwardedPorts']>()
const exec = vi.fn<WorkspaceDriver['exec']>()
/** Every forward declared, in order, with its workspace. */
let declared: Array<{ workspaceId: string; mapping: PortMapping }> = []

function workspace(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return handleFixture({
    jobName: 'yaac-proj-sess',
    workspaceId: 'sess-1',
    projectId: 'proj',
    ...overrides,
  })
}

/** What the status bar was set to, per job. */
const statusRightFor = (jobName: string): string | undefined =>
  exec.mock.calls.find((c) => c[0] === jobName)?.[1]

beforeEach(() => {
  vi.resetAllMocks()
  declared = []
  mockTmuxAlive.mockResolvedValue(true)
  forwardedPorts.mockResolvedValue([])
  exec.mockResolvedValue({ stdout: '', stderr: '' })
  projectConfig.mockResolvedValue({
    portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
  })
  installFakeWorkspaceDriver({
    list,
    forwardedPorts,
    exec,
    // A real allocator, so two workspaces asking for 3000 get different ports.
    declareForwards: (workspaceId, forwards) => forwards.map(({ containerPort, hostPortStart }) => {
      const taken = new Set(declared.map((d) => d.mapping.hostPort))
      let hostPort = hostPortStart
      while (taken.has(hostPort)) hostPort++
      const mapping = { containerPort, hostPort }
      declared.push({ workspaceId, mapping })
      return mapping
    }),
  })
})

describe('restoreAllWorkspaceForwarders', () => {
  it('declares each configured port with the driver, and states it on the bar', async () => {
    list.mockResolvedValue([
      workspace({ jobName: 'yaac-proj-s1', workspaceId: 's1' }),
      workspace({ jobName: 'yaac-proj-s2', workspaceId: 's2' }),
    ])

    await restoreAllWorkspaceForwarders(projectConfig)

    expect(declared).toHaveLength(2)
    for (const { mapping } of declared) {
      expect(mapping.containerPort).toBe(3000)
      expect(mapping.hostPort).toBeGreaterThanOrEqual(3000)
    }
    // Each workspace's bar shows its own mapping.
    for (const { workspaceId, mapping } of declared) {
      expect(statusRightFor(`yaac-proj-${workspaceId}`)).toContain(`:${mapping.hostPort}->3000`)
    }
  })

  it('clears a stale bar for a workspace with no forwards configured', async () => {
    // The bar may still show the previous server's forwards.
    projectConfig.mockResolvedValue({})
    list.mockResolvedValue([workspace()])

    await restoreAllWorkspaceForwarders(projectConfig)

    expect(declared).toEqual([])
    expect(statusRightFor('yaac-proj-sess')).toContain("status-right ' sess-1 '")
  })

  it('skips a workspace that is not running, or is missing its identity', async () => {
    list.mockResolvedValue([
      workspace({ running: false, state: 'failed' }),
      workspace({ workspaceId: '' }),
      workspace({ projectId: '' }),
      workspace({ jobName: '' }),
    ])
    await restoreAllWorkspaceForwarders(projectConfig)
    expect(declared).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('skips a workspace whose tmux is gone — the reaper owns that, not this', async () => {
    mockTmuxAlive.mockResolvedValue(false)
    list.mockResolvedValue([workspace()])
    await restoreAllWorkspaceForwarders(projectConfig)
    expect(declared).toEqual([])
  })

  it('skips a workspace that already has forwarders, since nothing was lost', async () => {
    forwardedPorts.mockResolvedValue([{ containerPort: 3000, hostPort: 3000 }])
    list.mockResolvedValue([workspace()])
    await restoreAllWorkspaceForwarders(projectConfig)
    expect(declared).toEqual([])
  })

  it('continues when the runtime cannot be listed', async () => {
    list.mockRejectedValue(new Error('cluster offline'))
    await expect(restoreAllWorkspaceForwarders(projectConfig)).resolves.toBeUndefined()
    expect(declared).toEqual([])
  })

  it('swallows one workspace\'s failure so it cannot block the rest', async () => {
    list.mockResolvedValue([
      workspace({ jobName: 'yaac-proj-a', workspaceId: 'a' }),
      workspace({ jobName: 'yaac-proj-b', workspaceId: 'b' }),
    ])
    exec.mockRejectedValueOnce(new Error('first failed'))

    await expect(restoreAllWorkspaceForwarders(projectConfig)).resolves.toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(2)
    // Only the (cosmetic) bar refresh failed; both forwards are declared.
    expect(declared).toHaveLength(2)
  })
})
