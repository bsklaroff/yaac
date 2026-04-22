import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getWaitingSessions } from '@/lib/session/waiting'

vi.mock('@/lib/container/runtime', () => ({
  podman: { listContainers: vi.fn() },
}))

vi.mock('@/lib/session/status', () => ({
  getSessionStatus: vi.fn(),
  getToolFromContainer: vi.fn(() => 'claude'),
}))

vi.mock('@/lib/project/paths', () => ({
  getDataDir: () => '/tmp/yaac-test',
}))

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockResolvedValue(true),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/lib/prewarm', () => ({
  isPrewarmSession: vi.fn().mockResolvedValue(false),
}))

import { podman } from '@/lib/container/runtime'
import { getSessionStatus, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { isPrewarmSession } from '@/lib/prewarm'

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockListContainers = vi.mocked(podman.listContainers)
const mockGetStatus = vi.mocked(getSessionStatus)
const mockGetToolFromContainer = vi.mocked(getToolFromContainer)
const mockIsTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)
const mockIsPrewarmSession = vi.mocked(isPrewarmSession)

describe('getWaitingSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetToolFromContainer.mockReturnValue('claude')
    mockIsTmuxAlive.mockResolvedValue(true)
    mockIsPrewarmSession.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns sessions with status=waiting sorted oldest first', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-newer'],
        Labels: { 'yaac.session-id': 'newer', 'yaac.project': 'proj' },
        Created: 2000,
        Id: '2',
      },
      {
        State: 'running',
        Names: ['/yaac-proj-older'],
        Labels: { 'yaac.session-id': 'older', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)
    mockGetStatus.mockResolvedValue('waiting')

    const result = await getWaitingSessions()
    expect(result.map((s) => s.sessionId)).toEqual(['older', 'newer'])
  })

  it('triggers detached cleanup for stale (exited/zombie) containers', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'exited',
        Names: ['/yaac-proj-dead'],
        Labels: { 'yaac.session-id': 'dead', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-dead',
      projectSlug: 'proj',
      sessionId: 'dead',
    })
  })

  it('skips sessions in alreadyCleaning without triggering cleanup', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-cleaning'],
        Labels: { 'yaac.session-id': 'cleaning', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions(undefined, new Set(['cleaning']))
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('respects project filter on the podman query', async () => {
    mockListContainers.mockResolvedValue([] as never)

    await getWaitingSessions('proj-a')
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: {
        label: ['yaac.data-dir=/tmp/yaac-test', 'yaac.project=proj-a'],
      },
    })
  })

  it('never sweeps a prewarm container even when its state is non-running', async () => {
    mockIsPrewarmSession.mockResolvedValue(true)
    mockListContainers.mockResolvedValue([
      {
        State: 'created',
        Names: ['/yaac-proj-prewarm'],
        Labels: { 'yaac.session-id': 'prewarm-new', 'yaac.project': 'proj' },
        Created: Math.floor(Date.now() / 1000),
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('never sweeps a running prewarm container with dead tmux', async () => {
    mockIsPrewarmSession.mockResolvedValue(true)
    mockIsTmuxAlive.mockResolvedValue(false)
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-prewarm'],
        Labels: { 'yaac.session-id': 'prewarm-starting', 'yaac.project': 'proj' },
        Created: Math.floor(Date.now() / 1000),
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('protects young non-prewarm containers from cleanup via the grace window', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'exited',
        Names: ['/yaac-proj-young'],
        Labels: { 'yaac.session-id': 'young', 'yaac.project': 'proj' },
        Created: Math.floor(Date.now() / 1000) - 5,
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('cleans up young stale containers when YAAC_STARTING_GRACE_MS=0', async () => {
    vi.stubEnv('YAAC_STARTING_GRACE_MS', '0')
    mockListContainers.mockResolvedValue([
      {
        State: 'exited',
        Names: ['/yaac-proj-young-stale'],
        Labels: { 'yaac.session-id': 'young-stale', 'yaac.project': 'proj' },
        Created: Math.floor(Date.now() / 1000) - 5,
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-young-stale',
      projectSlug: 'proj',
      sessionId: 'young-stale',
    })
  })
})
