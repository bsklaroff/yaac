/**
 * The forwarder restore — `restoreAllWorkspaceForwarders`.
 *
 * Mocked at the contract boundary only: the driver answers which workspaces
 * exist, which already have forwarders, and takes the bound sockets. The
 * host-port reservation, the candidate gating and the status-bar refresh all
 * run for real, which is what makes this cover the internals it drives
 * (`provisionForwarders`, the bar's format) without testing them directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PortMapping, YaacConfig } from '@yaac/shared/types'

vi.mock('#runtime/status/liveness', () => ({ isTmuxSessionAlive: vi.fn() }))

import { isTmuxSessionAlive } from '#runtime/status/liveness'
import { restoreAllWorkspaceForwarders } from '#runtime/ports/restore'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type { ReservedHostPort, RuntimeHandle, WorktreeDriver } from '#drivers/contract'

const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
/** The reader the caller supplies — main, once, as the server attaches. */
const projectConfig = vi.fn<(slug: string) => Promise<YaacConfig | undefined>>()

const list = vi.fn<WorktreeDriver['list']>()
const forwardedPorts = vi.fn<WorktreeDriver['forwardedPorts']>()
const exec = vi.fn<WorktreeDriver['exec']>()
/** Sockets the restore handed over. Held so the test can close them: a real
 *  reservation binds a real listener, and the fake driver never adopts one. */
let adopted: ReservedHostPort[] = []

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
  adopted = []
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
    startForwarders: (_id, ports) => { adopted.push(...ports) },
  })
})

afterEach(() => {
  for (const p of adopted) p.server.close()
})

describe('restoreAllWorkspaceForwarders', () => {
  it('reserves each configured port and hands the bound sockets to the driver', async () => {
    list.mockResolvedValue([
      workspace({ jobName: 'yaac-proj-s1', workspaceId: 's1' }),
      workspace({ jobName: 'yaac-proj-s2', workspaceId: 's2' }),
    ])

    await restoreAllWorkspaceForwarders(projectConfig)

    expect(adopted).toHaveLength(2)
    for (const p of adopted) {
      expect(p.containerPort).toBe(3000)
      // Reserved from the configured start, walking up when it is taken —
      // which is exactly what the second workspace hits.
      expect(p.hostPort).toBeGreaterThanOrEqual(3000)
      expect(p.server.listening).toBe(true)
    }
    // Each workspace's bar advertises its OWN mapping, not the other's.
    const mapping = (ports: ReservedHostPort[]): PortMapping[] =>
      ports.map(({ containerPort, hostPort }) => ({ containerPort, hostPort }))
    const [first, second] = mapping(adopted)
    expect(statusRightFor('yaac-proj-s1')).toContain(`:${first.hostPort}->3000`)
    expect(statusRightFor('yaac-proj-s2')).toContain(`:${second.hostPort}->3000`)
  })

  it('clears a stale bar for a workspace with no forwards configured', async () => {
    // The workspace is still advertising what the previous server forwarded,
    // so the refresh has to run even when there is nothing to reserve.
    projectConfig.mockResolvedValue({})
    list.mockResolvedValue([workspace()])

    await restoreAllWorkspaceForwarders(projectConfig)

    expect(adopted).toEqual([])
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
    expect(adopted).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('skips a workspace whose tmux is gone — the reaper owns that, not this', async () => {
    mockTmuxAlive.mockResolvedValue(false)
    list.mockResolvedValue([workspace()])
    await restoreAllWorkspaceForwarders(projectConfig)
    expect(adopted).toEqual([])
  })

  it('skips a workspace that already has forwarders, since nothing was lost', async () => {
    forwardedPorts.mockResolvedValue([{ containerPort: 3000, hostPort: 3000 }])
    list.mockResolvedValue([workspace()])
    await restoreAllWorkspaceForwarders(projectConfig)
    expect(adopted).toEqual([])
  })

  it('continues when the runtime cannot be listed', async () => {
    list.mockRejectedValue(new Error('cluster offline'))
    await expect(restoreAllWorkspaceForwarders(projectConfig)).resolves.toBeUndefined()
    expect(adopted).toEqual([])
  })

  it('swallows one workspace\'s failure so it cannot block the rest', async () => {
    list.mockResolvedValue([
      workspace({ jobName: 'yaac-proj-a', workspaceId: 'a' }),
      workspace({ jobName: 'yaac-proj-b', workspaceId: 'b' }),
    ])
    exec.mockRejectedValueOnce(new Error('first failed'))

    await expect(restoreAllWorkspaceForwarders(projectConfig)).resolves.toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(2)
    // The one that failed reserved a port and never handed it over; the other
    // still got its forwarders.
    expect(adopted).toHaveLength(1)
  })
})
