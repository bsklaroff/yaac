import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getWaitingSessions, sessionStream } from '@/commands/session-stream'

vi.mock('@/lib/container/runtime', () => ({
  podman: {
    listContainers: vi.fn(),
  },
}))

vi.mock('@/lib/session/claude-status', () => ({
  getSessionClaudeStatus: vi.fn(),
}))

vi.mock('@/lib/project/paths', () => ({
  getDataDir: () => '/tmp/yaac-test',
}))

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockReturnValue(true),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/commands/session-create', () => ({
  sessionCreate: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { podman } from '@/lib/container/runtime'
import { getSessionClaudeStatus } from '@/lib/session/claude-status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
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

  it('skips sessions in alreadyCleaning set without triggering cleanup', async () => {
    mockIsTmuxAlive.mockReturnValue(true)
    mockListContainers.mockResolvedValue([
      {
        State: 'running',
        Names: ['/yaac-proj-cleaning'],
        Labels: { 'yaac.session-id': 'cleaning-id', 'yaac.project': 'proj' },
        Created: 1000,
        Id: '1',
      },
      {
        State: 'running',
        Names: ['/yaac-proj-normal'],
        Labels: { 'yaac.session-id': 'normal-id', 'yaac.project': 'proj' },
        Created: 2000,
        Id: '2',
      },
    ] as never)
    mockGetStatus.mockResolvedValue('waiting')

    const result = await getWaitingSessions(undefined, new Set(['cleaning-id']))
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('normal-id')
    // Should not have called isTmuxSessionAlive for the cleaning session
    expect(mockIsTmuxAlive).toHaveBeenCalledTimes(1)
    expect(mockIsTmuxAlive).toHaveBeenCalledWith('yaac-proj-normal')
    // Should not trigger cleanup for it
    expect(mockCleanupDetached).not.toHaveBeenCalled()
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

  it('retries once when podman connection fails after tmux detach', async () => {
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('socket hang up'))
      // Retry succeeds but returns no sessions → exits
      return Promise.resolve([])
    })

    await sessionStream()

    expect(callCount).toBe(2)
  })

  it('exits with error when both attempts fail', async () => {
    mockListContainers.mockRejectedValue(new Error('socket hang up'))

    await sessionStream()

    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('exits when no sessions and no project is provided', async () => {
    mockListContainers.mockResolvedValue([])

    await sessionStream()

    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('clears visited set (except last) when all waiting sessions have been visited', async () => {
    // We need to mock execSync so tmux attach doesn't actually run
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    mockIsTmuxAlive.mockReturnValue(true)
    mockGetStatus.mockResolvedValue('waiting')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }
    const containerB = {
      State: 'running',
      Names: ['/yaac-proj-b'],
      Labels: { 'yaac.session-id': 'bbb', 'yaac.project': 'proj' },
      Created: 2000,
      Id: '2',
    }

    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      // Calls 1-3: both containers exist and are waiting
      // Call 4+: return empty to break the loop
      if (callCount <= 3) return Promise.resolve([containerA, containerB] as never)
      return Promise.resolve([])
    })

    await sessionStream()

    // Should have attached to: A (oldest), B, then after clearing visited: A again.
    // Visited filtering now happens locally (no extra listContainers call on
    // wrap-around), so 3 listContainers calls yield 3 attaches.
    expect(vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3)

    // First attach should be to A (oldest)
    const calls = vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toContain('yaac-proj-a')
    // Second attach should be to B
    expect(calls[1][0]).toContain('yaac-proj-b')
    // Third attach should be to A again (visited was cleared, only B excluded as lastVisited)
    expect(calls[2][0]).toContain('yaac-proj-a')
  })

  it('revisits a session after wrap-around instead of repeatedly creating new ones', async () => {
    // Scenario: session A is the only waiting session. After visiting A, the
    // wrap-around excludes it (lastVisited). That triggers sessionCreate. On
    // the next iteration A is still the only session. If lastVisited was
    // cleared after the first wrap-around, the second wrap-around sees
    // visited={} and re-attaches to A. Without clearing, A stays permanently
    // excluded and we just keep calling sessionCreate.
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    mockIsTmuxAlive.mockReturnValue(true)
    mockGetStatus.mockResolvedValue('waiting')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    // Always return A as a waiting session
    mockListContainers.mockResolvedValue([containerA] as never)

    // Cap sessionCreate at 2 calls then throw to break the loop.
    // With the fix:   visit A → create(1) → visit A → create(2) → throw  (2 attaches)
    // Without the fix: visit A → create(1) → create(2) → throw            (1 attach)
    let createCount = 0
    mockSessionCreate.mockImplementation(() => {
      createCount++
      if (createCount >= 2) throw new Error('stop')
      return Promise.resolve(undefined)
    })

    await sessionStream('my-project').catch(() => {})

    const calls = vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mock.calls
    // A must be visited a second time between the two sessionCreate calls,
    // proving that clearing lastVisited allowed the wrap-around to unblock A.
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toContain('yaac-proj-a')
    expect(calls[1][0]).toContain('yaac-proj-a')
  })

  it('does not double-cleanup a killed session on the next loop iteration', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    // First call: return containerA (will be attached + killed)
    // Second call: containerA still shows as running (cleanup in progress)
    // Third call: return empty to exit
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount <= 2) return Promise.resolve([containerA] as never)
      return Promise.resolve([])
    })

    // First getWaitingSessions: alive, second (after kill): dead
    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      // First two calls (getWaitingSessions filter + post-attach check): alive then dead
      // The bug was that the third call (next getWaitingSessions filter) would also
      // detect the zombie and trigger a second cleanup.
      return tmuxCheckCount <= 1
    })
    mockGetStatus.mockResolvedValue('waiting')

    await sessionStream()

    // cleanupSessionDetached should be called exactly once (from the post-attach
    // dead check), not a second time from getWaitingSessions on the next iteration
    expect(mockCleanupDetached).toHaveBeenCalledTimes(1)
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-a',
      projectSlug: 'proj',
      sessionId: 'aaa',
    })
  })
})
