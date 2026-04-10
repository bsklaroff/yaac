import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getWaitingSessions, sessionStream } from '@/commands/session-stream'

vi.mock('@/lib/podman', () => ({
  podman: {
    listContainers: vi.fn(),
  },
}))

vi.mock('@/lib/claude-status', () => ({
  getSessionClaudeStatus: vi.fn(),
}))

vi.mock('@/lib/paths', () => ({
  getDataDir: () => '/tmp/yaac-test',
}))

vi.mock('@/lib/session-cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockReturnValue(true),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/commands/session-create', () => ({
  sessionCreate: vi.fn(),
}))

import { podman } from '@/lib/podman'
import { getSessionClaudeStatus } from '@/lib/claude-status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session-cleanup'
import { sessionCreate } from '@/commands/session-create'

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockListContainers = vi.mocked(podman.listContainers)
const mockGetStatus = vi.mocked(getSessionClaudeStatus)
const mockIsTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)
const mockSessionCreate = vi.mocked(sessionCreate)

describe('getWaitingSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns empty array when no containers exist', async () => {
    mockListContainers.mockResolvedValue([])
    const result = await getWaitingSessions()
    expect(result).toEqual([])
  })

  it('filters out non-running containers', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'exited',
        Names: ['/yaac-proj-abc'],
        Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)
    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockGetStatus).not.toHaveBeenCalled()
  })

  it('filters out non-waiting sessions', async () => {
    mockIsTmuxAlive.mockReturnValue(true)
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-abc'],
        Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)
    mockGetStatus.mockResolvedValue('running')
    const result = await getWaitingSessions()
    expect(result).toEqual([])
  })

  it('returns waiting sessions sorted oldest first', async () => {
    mockIsTmuxAlive.mockReturnValue(true)
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-newer'],
        Labels: { 'yaac.session-id': 'newer-id', 'yaac.project': 'proj' },
        Created: 2000,
        Id: '2',
      },
      {
        State: 'running',
        Names: ['/yaac-proj-older'],
        Labels: { 'yaac.session-id': 'older-id', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)
    mockGetStatus.mockResolvedValue('waiting')

    const result = await getWaitingSessions()
    expect(result).toHaveLength(2)
    expect(result[0].sessionId).toBe('older-id')
    expect(result[1].sessionId).toBe('newer-id')
  })

  it('respects project filter', async () => {
    mockIsTmuxAlive.mockReturnValue(true)
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-a-abc'],
        Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'proj-a' },
        Created: 1000,
        Id: '1',
      },
    ] as never)
    mockGetStatus.mockResolvedValue('waiting')

    await getWaitingSessions('proj-a')
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: {
        label: ['yaac.data-dir=/tmp/yaac-test', 'yaac.project=proj-a'],
      },
    })
  })

  it('excludes specified session IDs', async () => {
    mockIsTmuxAlive.mockReturnValue(true)
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-abc'],
        Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
      {
        State: 'running',
        Names: ['/yaac-proj-def'],
        Labels: { 'yaac.session-id': 'def', 'yaac.project': 'proj' },
        Created: 2000,
        Id: '2',
      },
    ] as never)
    mockGetStatus.mockResolvedValue('waiting')

    const result = await getWaitingSessions(undefined, new Set(['abc']))
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('def')
  })

  it('filters out zombie containers and cleans them up', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-zombie'],
        Labels: { 'yaac.session-id': 'zombie-id', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
      {
        State: 'running',
        Names: ['/yaac-proj-alive'],
        Labels: { 'yaac.session-id': 'alive-id', 'yaac.project': 'proj' },
        Created: 2000,
        Id: '2',
      },
    ] as never)
    mockIsTmuxAlive.mockImplementation((name) => name === 'yaac-proj-alive')
    mockGetStatus.mockResolvedValue('waiting')

    const result = await getWaitingSessions()
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('alive-id')
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-zombie',
      projectSlug: 'proj',
      sessionId: 'zombie-id',
    })
  })

  it('cleans up exited containers in background', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'exited',
        Names: ['/yaac-proj-exited'],
        Labels: { 'yaac.session-id': 'exited-id', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
    ] as never)

    const result = await getWaitingSessions()
    expect(result).toEqual([])
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-exited',
      projectSlug: 'proj',
      sessionId: 'exited-id',
    })
  })

  it('skips containers without session ID or project labels', async () => {
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/some-container'],
        Labels: {},
        Created: 1000,
        Id: '1',
      },
    ] as never)
    const result = await getWaitingSessions()
    expect(result).toEqual([])
  })
})

describe('sessionStream', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('is exported as a function', () => {
    expect(typeof sessionStream).toBe('function')
  })

  it('calls sessionCreate when no sessions and project is provided', async () => {
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount <= 1) return Promise.resolve([])
      // After sessionCreate is called, simulate the process exiting
      // by throwing to break the loop
      throw new Error('stop')
    })
    mockSessionCreate.mockResolvedValue(undefined)

    await sessionStream('my-project')

    expect(mockSessionCreate).toHaveBeenCalledWith('my-project', {})
  })

  it('exits when no sessions and no project is provided', async () => {
    mockListContainers.mockResolvedValue([])

    await sessionStream()

    expect(mockSessionCreate).not.toHaveBeenCalled()
  })
})
