import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  isTmuxSessionAlive: vi.fn().mockReturnValue(true),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/lib/prewarm', () => ({
  isPrewarmSession: vi.fn().mockResolvedValue(false),
}))

import { podman } from '@/lib/container/runtime'
import { getSessionStatus, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockListContainers = vi.mocked(podman.listContainers)
const mockGetStatus = vi.mocked(getSessionStatus)
const mockGetToolFromContainer = vi.mocked(getToolFromContainer)
const mockIsTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)

describe('getWaitingSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetToolFromContainer.mockReturnValue('claude')
    mockIsTmuxAlive.mockReturnValue(true)
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
})
