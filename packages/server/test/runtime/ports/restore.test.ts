/**
 * The forwarder restore — `restoreAllWorkspaceForwarders`.
 *
 * Mocked at the contract boundary only: the driver answers which workspaces
 * exist, which already have forwarders, and what each declared forward is
 * offered at. The candidate gating and the status-bar refresh run for real,
 * which is what makes this cover the internals it drives
 * (`provisionForwarders`, the bar's format) without testing them directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PortMapping, YaacConfig } from '@yaac/shared/types'

vi.mock('#runtime/status/liveness', () => ({ isTmuxSessionAlive: vi.fn() }))

import { isTmuxSessionAlive } from '#runtime/status/liveness'
import { restoreAllWorkspaceForwarders } from '#runtime/ports/restore'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type { RuntimeHandle, WorktreeDriver } from '#drivers/contract'

const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
/** The reader the caller supplies — main, once, as the server attaches. */
const projectConfig = vi.fn<(slug: string) => Promise<YaacConfig | undefined>>()

const list = vi.fn<WorktreeDriver['list']>()
const forwardedPorts = vi.fn<WorktreeDriver['forwardedPorts']>()
const exec = vi.fn<WorktreeDriver['exec']>()
/** Every declaration the restore made, in order, with the workspace it was
 *  made for — nothing is bound, so this IS the observable effect. */
let declared: Array<{ workspaceId: string; mapping: PortMapping }> = []

function workspace(overrides: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return handleFixture({
    jobName: 'yaac-proj-sess',
    workspaceId: 'sess-1',
    projectSlug: 'proj',
    ...overrides,
  })
}

/** What the status bar was set to, per job — the one exec this path issues. */
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
  installFakeWorktreeDriver({
    list,
    forwardedPorts,
    exec,
    // A real allocator, so two workspaces asking for 3000 get different
    // answers — which is what the bar assertions below turn on.
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
      // Offered from the configured start, walking up when it is taken —
      // which is exactly what the second workspace hits.
      expect(mapping.hostPort).toBeGreaterThanOrEqual(3000)
    }
    // Each workspace's bar advertises its OWN mapping, not the other's.
    for (const { workspaceId, mapping } of declared) {
      expect(statusRightFor(`yaac-proj-${workspaceId}`)).toContain(`:${mapping.hostPort}->3000`)
    }
  })

  it('clears a stale bar for a workspace with no forwards configured', async () => {
    // The workspace is still advertising what the previous server forwarded,
    // so the refresh has to run even when there is nothing to reserve.
    projectConfig.mockResolvedValue({})
    list.mockResolvedValue([workspace()])

    await restoreAllWorkspaceForwarders(projectConfig)

    expect(declared).toEqual([])
    expect(statusRightFor('yaac-proj-sess')).toContain("status-right ' proj sess-1 '")
  })

  it('skips a workspace that is not running, or is missing its identity', async () => {
    list.mockResolvedValue([
      workspace({ running: false, state: 'failed' }),
      workspace({ workspaceId: '' }),
      workspace({ projectSlug: '' }),
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
    // Both declared — the failure is the bar refresh, which is the last
    // step and cosmetic; only one workspace's bar is left stale.
    expect(declared).toHaveLength(2)
  })
})
