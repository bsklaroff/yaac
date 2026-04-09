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

import { podman } from '@/lib/podman'
import { getSessionClaudeStatus } from '@/lib/claude-status'

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockListContainers = vi.mocked(podman.listContainers)
const mockGetStatus = vi.mocked(getSessionClaudeStatus)

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
  it('is exported as a function', () => {
    expect(typeof sessionStream).toBe('function')
  })
})
