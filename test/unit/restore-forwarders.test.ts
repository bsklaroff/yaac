import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/container/runtime', () => ({
  podman: {
    listContainers: vi.fn(),
  },
}))

vi.mock('@/lib/project/paths', () => ({
  getDataDir: vi.fn(() => '/tmp/yaac-data'),
}))

vi.mock('@/lib/project/config', () => ({
  resolveProjectConfig: vi.fn(),
}))

vi.mock('@/lib/prewarm', () => ({
  readPrewarmSessions: vi.fn(),
}))

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn(),
}))

vi.mock('@/lib/session/port-forwarders', () => ({
  hasSessionForwarders: vi.fn(),
  provisionSessionForwarders: vi.fn(),
}))

import { podman } from '@/lib/container/runtime'
import { resolveProjectConfig } from '@/lib/project/config'
import { readPrewarmSessions } from '@/lib/prewarm'
import { isTmuxSessionAlive } from '@/lib/session/cleanup'
import { hasSessionForwarders, provisionSessionForwarders } from '@/lib/session/port-forwarders'
import { restoreAllSessionForwarders } from '@/lib/session/restore-forwarders'

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockListContainers = vi.mocked(podman.listContainers)
const mockResolveConfig = vi.mocked(resolveProjectConfig)
const mockReadPrewarm = vi.mocked(readPrewarmSessions)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockHasForwarders = vi.mocked(hasSessionForwarders)
const mockProvision = vi.mocked(provisionSessionForwarders)

function container(overrides: Partial<Record<string, unknown>> = {}): never {
  return {
    Id: 'id-' + Math.random().toString(36).slice(2),
    Names: ['/yaac-proj-sess'],
    Labels: {
      'yaac.session-id': 'sess-1',
      'yaac.project': 'proj',
    },
    State: 'running',
    ...overrides,
  } as never
}

describe('restoreAllSessionForwarders', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockReadPrewarm.mockResolvedValue({})
    mockTmuxAlive.mockResolvedValue(true)
    mockHasForwarders.mockReturnValue(false)
    mockResolveConfig.mockResolvedValue({
      portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
    })
    mockProvision.mockResolvedValue([{ containerPort: 3000, hostPort: 3000 }])
  })

  it('provisions forwarders for each running, non-prewarm container', async () => {
    mockListContainers.mockResolvedValue([
      container({ Names: ['/yaac-proj-sess1'], Labels: { 'yaac.session-id': 'sess1', 'yaac.project': 'proj' } }),
      container({ Names: ['/yaac-proj-sess2'], Labels: { 'yaac.session-id': 'sess2', 'yaac.project': 'proj' } }),
    ] as never)

    await restoreAllSessionForwarders()

    expect(mockProvision).toHaveBeenCalledTimes(2)
    expect(mockProvision).toHaveBeenCalledWith(
      'proj', 'sess1', 'yaac-proj-sess1', [{ containerPort: 3000, hostPortStart: 3000 }],
    )
    expect(mockProvision).toHaveBeenCalledWith(
      'proj', 'sess2', 'yaac-proj-sess2', [{ containerPort: 3000, hostPortStart: 3000 }],
    )
  })

  it('skips prewarmed containers', async () => {
    mockReadPrewarm.mockResolvedValue({
      proj: {
        sessionId: 'prewarm-sess',
        containerName: 'yaac-proj-prewarm-sess',
        fingerprint: 'fp',
        state: 'ready',
        verifiedAt: Date.now(),
      },
    })
    mockListContainers.mockResolvedValue([
      container({
        Names: ['/yaac-proj-prewarm-sess'],
        Labels: { 'yaac.session-id': 'prewarm-sess', 'yaac.project': 'proj' },
      }),
      container({
        Names: ['/yaac-proj-live'],
        Labels: { 'yaac.session-id': 'live', 'yaac.project': 'proj' },
      }),
    ] as never)

    await restoreAllSessionForwarders()

    expect(mockProvision).toHaveBeenCalledTimes(1)
    expect(mockProvision).toHaveBeenCalledWith(
      'proj', 'live', 'yaac-proj-live', [{ containerPort: 3000, hostPortStart: 3000 }],
    )
  })

  it('skips containers that are not running', async () => {
    mockListContainers.mockResolvedValue([
      container({ State: 'exited' }),
    ] as never)
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips containers with a dead tmux session', async () => {
    mockTmuxAlive.mockResolvedValue(false)
    mockListContainers.mockResolvedValue([container()] as never)
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('skips containers whose forwarders are already registered', async () => {
    mockHasForwarders.mockReturnValue(true)
    mockListContainers.mockResolvedValue([container()] as never)
    await restoreAllSessionForwarders()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('continues when listContainers throws', async () => {
    mockListContainers.mockRejectedValue(new Error('podman offline'))
    await expect(restoreAllSessionForwarders()).resolves.toBeUndefined()
    expect(mockProvision).not.toHaveBeenCalled()
  })

  it('swallows per-container provision errors so one failure does not block the rest', async () => {
    mockListContainers.mockResolvedValue([
      container({ Names: ['/yaac-proj-a'], Labels: { 'yaac.session-id': 'a', 'yaac.project': 'proj' } }),
      container({ Names: ['/yaac-proj-b'], Labels: { 'yaac.session-id': 'b', 'yaac.project': 'proj' } }),
    ] as never)
    mockProvision
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce([])

    await expect(restoreAllSessionForwarders()).resolves.toBeUndefined()
    expect(mockProvision).toHaveBeenCalledTimes(2)
  })
})
