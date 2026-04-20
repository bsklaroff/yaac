import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getWaitingSessions, sessionStream, promptForProject } from '@/commands/session-stream'

vi.mock('@/lib/container/runtime', () => ({
  podman: {
    listContainers: vi.fn(),
  },
}))

vi.mock('@/lib/session/status', () => ({
  getSessionStatus: vi.fn(),
  getSessionFirstMessage: vi.fn(),
  getToolFromContainer: vi.fn(() => 'claude'),
}))

vi.mock('@/lib/project/paths', () => ({
  getDataDir: () => '/tmp/yaac-test',
  getProjectsDir: () => '/tmp/yaac-test/projects',
}))

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockReturnValue(true),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/commands/session-create', () => ({
  createSession: vi.fn(),
  sessionCreate: vi.fn(),
}))

vi.mock('@/lib/prewarm', () => ({
  isPrewarmSession: vi.fn().mockResolvedValue(false),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn().mockRejectedValue(new Error('no dir')),
  },
}))

vi.mock('node:readline/promises', () => {
  const mockQuestion = vi.fn()
  const mockClose = vi.fn()
  return {
    default: {
      createInterface: vi.fn().mockReturnValue({
        question: mockQuestion,
        close: mockClose,
      }),
    },
  }
})

import { podman } from '@/lib/container/runtime'
import { getSessionFirstMessage, getSessionStatus, getToolFromContainer } from '@/lib/session/status'
import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { createSession } from '@/commands/session-create'
import fs from 'node:fs/promises'
import readline from 'node:readline/promises'

const mockReaddir = vi.mocked(fs.readdir)
const mockCreateInterface = vi.mocked(readline.createInterface)

// eslint-disable-next-line @typescript-eslint/unbound-method
const mockListContainers = vi.mocked(podman.listContainers)
const mockGetStatus = vi.mocked(getSessionStatus)
const mockGetFirstMessage = vi.mocked(getSessionFirstMessage)
const mockGetToolFromContainer = vi.mocked(getToolFromContainer)
const mockIsTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)
const mockCreateSession = vi.mocked(createSession)

describe('getWaitingSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetToolFromContainer.mockReturnValue('claude')
    mockCreateSession.mockResolvedValue({ sessionId: 'created-session' })
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
    expect(result[0].tool).toBe('claude')
    expect(result[1].tool).toBe('claude')
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
    mockGetToolFromContainer.mockReturnValue('claude')
  })

  it('is exported as a function', () => {
    expect(typeof sessionStream).toBe('function')
  })

  it('calls createSession when no sessions and project is provided', async () => {
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount <= 1) return Promise.resolve([])
      // After createSession is called, simulate the process exiting
      // by throwing to break the loop
      throw new Error('stop')
    })
    mockCreateSession.mockResolvedValue({ sessionId: 'created-session' })

    await sessionStream('my-project')

    expect(mockCreateSession).toHaveBeenCalledWith('my-project', { tool: undefined })
  })

  it('exits when createSession returns undefined (e.g. project not found)', async () => {
    mockListContainers.mockResolvedValue([])
    mockCreateSession.mockResolvedValue(undefined)

    await sessionStream('nonexistent-project')

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
  })

  it('retries once when podman connection fails after tmux detach', async () => {
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('socket hang up'))
      // Retry succeeds but returns no sessions → chooseNextAction resolves
      // the project, which calls listContainers via getActiveProjects (call 3)
      return Promise.resolve([])
    })

    await sessionStream()

    // 1: initial (fails), 2: retry (empty), 3: getActiveProjects during project resolution
    expect(callCount).toBe(3)
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

    expect(mockCreateSession).not.toHaveBeenCalled()
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

  it('revisits a session after wrap-around instead of repeatedly creating new ones when it has a prompt', async () => {
    // Scenario: session A is the only waiting session. After visiting A, the
    // wrap-around excludes it (lastVisited). That triggers createSession. On
    // the next iteration A is still the only session. If lastVisited was
    // cleared after the first wrap-around, the second wrap-around sees
    // visited={} and re-attaches to A. Without clearing, A stays permanently
    // excluded and we just keep calling createSession.
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    mockIsTmuxAlive.mockReturnValue(true)
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue('fix the login bug')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    // Always return A as a waiting session
    mockListContainers.mockResolvedValue([containerA] as never)

    // Cap createSession at 2 calls then throw to break the loop.
    // With the fix:   visit A → create(1) → visit A → create(2) → throw  (2 attaches)
    // Without the fix: visit A → create(1) → create(2) → throw            (1 attach)
    let createCount = 0
    mockCreateSession.mockImplementation(() => {
      createCount++
      if (createCount >= 2) throw new Error('stop')
      return Promise.resolve({ sessionId: `created-${createCount}` })
    })

    await sessionStream('my-project').catch(() => {})

    const calls = vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mock.calls
    // A must be visited a second time between the two createSession calls,
    // proving that clearing lastVisited allowed the wrap-around to unblock A.
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toContain('yaac-proj-a')
    expect(calls[1][0]).toContain('yaac-proj-a')
  })

  it('tracks the newly created session as lastVisited so the prior waiting session can be revisited immediately', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    mockListContainers.mockResolvedValue([containerA] as never)
    mockIsTmuxAlive.mockReturnValue(true)
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue('fix the login bug')

    let createCount = 0
    mockCreateSession.mockImplementation(() => {
      createCount++
      if (createCount >= 2) throw new Error('stop')
      return Promise.resolve({ sessionId: `created-${createCount}`, attachOutcome: 'detached' })
    })

    await sessionStream('my-project').catch(() => {})

    expect(mockCreateSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('yaac-proj-a')
    expect(vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain('yaac-proj-a')
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

  it('exits instead of creating a new session after a blank session closes', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([containerA] as never)
      return Promise.resolve([])
    })

    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      return tmuxCheckCount === 1
    })
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue(undefined)

    await sessionStream('my-project')

    expect(mockGetFirstMessage).toHaveBeenCalledWith('proj', 'aaa', 'claude')
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('exits after a blank session closes when no project was specified', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([containerA] as never)
      return Promise.resolve([])
    })

    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      return tmuxCheckCount === 1
    })
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue(undefined)

    await sessionStream()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockReaddir).not.toHaveBeenCalled()
  })

  it('exits after detaching the only waiting blank session instead of creating a new one', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    mockListContainers.mockResolvedValue([containerA] as never)

    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      return tmuxCheckCount === 1
    })
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue(undefined)

    await sessionStream('my-project')

    expect(mockGetFirstMessage).toHaveBeenCalledWith('proj', 'aaa', 'claude')
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('exits on wrap-around when the only visited waiting session is blank', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    mockListContainers.mockResolvedValue([containerA] as never)
    mockIsTmuxAlive.mockReturnValue(true)
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue(undefined)

    await sessionStream('my-project')

    expect(mockGetFirstMessage).toHaveBeenCalledWith('proj', 'aaa', 'claude')
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('creates a new session on wrap-around when the only visited waiting session has a prompt', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    mockListContainers.mockResolvedValue([containerA] as never)
    mockIsTmuxAlive.mockReturnValue(true)
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue('fix the login bug')
    mockCreateSession.mockImplementation(() => {
      throw new Error('stop')
    })

    await sessionStream('my-project').catch(() => {})

    expect(mockGetFirstMessage).toHaveBeenCalledWith('proj', 'aaa', 'claude')
    expect(mockCreateSession).toHaveBeenCalledWith('my-project', { tool: undefined })
  })

  it('creates a new session after a closed session with a recorded prompt', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }

    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([containerA] as never)
      return Promise.resolve([])
    })

    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      return tmuxCheckCount === 1
    })
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue('fix the login bug')
    mockCreateSession.mockImplementation(() => {
      throw new Error('stop')
    })

    await sessionStream('my-project').catch(() => {})

    expect(mockCreateSession).toHaveBeenCalledWith('my-project', { tool: undefined })
    expect(mockCleanupDetached).toHaveBeenCalledTimes(1)
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-a',
      projectSlug: 'proj',
      sessionId: 'aaa',
    })
    expect(mockCleanupDetached.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSession.mock.invocationCallOrder[0],
    )
  })

  it('cleans up before resolving and recreating after a prompted session closes with no project set', async () => {
    const { execSync } = await import('node:child_process')
    vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => '')

    const closedSession = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj' },
      Created: 1000,
      Id: '1',
    }
    const activeProjectContainer = {
      State: 'running',
      Names: ['/yaac-proj-bbb'],
      Labels: { 'yaac.session-id': 'bbb', 'yaac.project': 'my-proj', 'yaac.tool': 'claude' },
      Created: 2000,
      Id: '2',
    }

    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([closedSession] as never)
      if (callCount === 2) return Promise.resolve([])
      if (callCount === 3) return Promise.resolve([activeProjectContainer] as never)
      if (callCount === 4) return Promise.resolve([])
      return Promise.resolve([])
    })

    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      return tmuxCheckCount !== 2
    })
    mockGetStatus.mockResolvedValue('waiting')
    mockGetFirstMessage.mockResolvedValue('fix the login bug')
    mockCreateSession.mockImplementation(() => {
      throw new Error('stop')
    })

    await sessionStream().catch(() => {})

    expect(mockCleanupDetached).toHaveBeenCalledTimes(1)
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-proj-a',
      projectSlug: 'proj',
      sessionId: 'aaa',
    })
    expect(mockCreateSession).toHaveBeenCalledWith('my-proj', { tool: undefined })
    expect(mockCleanupDetached.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateSession.mock.invocationCallOrder[0],
    )
  })

  it('attaches to another waiting session instead of exiting after a blank session closes', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync as unknown as ReturnType<typeof vi.fn>)
    mockedExecSync.mockImplementation(() => '')

    const containerA = {
      State: 'running',
      Names: ['/yaac-proj-a'],
      Labels: { 'yaac.session-id': 'aaa', 'yaac.project': 'proj', 'yaac.tool': 'codex' },
      Created: 1000,
      Id: '1',
    }
    const containerB = {
      State: 'running',
      Names: ['/yaac-proj-b'],
      Labels: { 'yaac.session-id': 'bbb', 'yaac.project': 'proj', 'yaac.tool': 'claude' },
      Created: 2000,
      Id: '2',
    }

    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([containerA, containerB] as never)
      if (callCount === 2) return Promise.resolve([containerA, containerB] as never)
      throw new Error('stop')
    })

    let tmuxCheckCount = 0
    mockIsTmuxAlive.mockImplementation(() => {
      tmuxCheckCount++
      if (tmuxCheckCount === 1) return true
      if (tmuxCheckCount === 2) return true
      if (tmuxCheckCount === 3) return false
      if (tmuxCheckCount === 4) return true
      return false
    })
    mockGetStatus.mockResolvedValue('waiting')
    mockGetToolFromContainer.mockImplementation((container) => container.Labels?.['yaac.tool'] === 'codex' ? 'codex' : 'claude')
    mockGetFirstMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await sessionStream('my-project')

    expect(mockGetFirstMessage).toHaveBeenCalledWith('proj', 'aaa', 'codex')
    expect(mockedExecSync).toHaveBeenCalledTimes(2)
    expect(mockedExecSync.mock.calls[0][0]).toContain('yaac-proj-a')
    expect(mockedExecSync.mock.calls[1][0]).toContain('yaac-proj-b')
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('auto-selects project when only one has active containers', async () => {
    // First call (getWaitingSessions): no waiting sessions
    // Second call (getActiveProjects): one project with a running container
    // Third call (getWaitingSessions with resolved project set): still empty → creates session
    // Fourth call: throw to exit loop
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([])
      if (callCount === 2) {
        return Promise.resolve([
          {
            State: 'running',
            Names: ['/yaac-proj-abc'],
            Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'my-proj', 'yaac.tool': 'claude' },
            Created: 1000,
            Id: '1',
          },
        ] as never)
      }
      if (callCount === 3) return Promise.resolve([])
      throw new Error('stop')
    })
    mockIsTmuxAlive.mockReturnValue(true)
    mockCreateSession.mockResolvedValue({ sessionId: 'created-session' })

    await sessionStream()

    expect(mockCreateSession).toHaveBeenCalledWith('my-proj', { tool: undefined })
  })

  it('prompts user when multiple projects have active containers', async () => {
    // First call (getWaitingSessions): no waiting sessions
    // Second call (getActiveProjects): two projects
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([])
      if (callCount === 2) {
        return Promise.resolve([
          {
            State: 'running',
            Names: ['/yaac-a-abc'],
            Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'proj-a', 'yaac.tool': 'claude' },
            Created: 1000,
            Id: '1',
          },
          {
            State: 'running',
            Names: ['/yaac-b-def'],
            Labels: { 'yaac.session-id': 'def', 'yaac.project': 'proj-b', 'yaac.tool': 'claude' },
            Created: 2000,
            Id: '2',
          },
        ] as never)
      }
      if (callCount === 3) return Promise.resolve([])
      throw new Error('stop')
    })
    mockIsTmuxAlive.mockReturnValue(true)
    mockCreateSession.mockResolvedValue({ sessionId: 'created-session' })

    const mockQuestion = vi.fn().mockResolvedValue('2')
    mockCreateInterface.mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never)

    await sessionStream()

    expect(mockCreateSession).toHaveBeenCalledWith('proj-b', { tool: undefined })
  })

  it('falls back to all projects when no active containers exist', async () => {
    mockListContainers.mockResolvedValue([])
    mockReaddir.mockResolvedValue(['alpha', 'beta'] as never)

    const mockQuestion = vi.fn().mockResolvedValue('1')
    mockCreateInterface.mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never)
    mockCreateSession.mockImplementation(() => {
      // After creating session, throw to break loop
      throw new Error('stop')
    })

    await sessionStream().catch(() => {})

    expect(mockCreateSession).toHaveBeenCalledWith('alpha', { tool: undefined })
  })

  it('exits when no projects are configured and no active containers', async () => {
    mockListContainers.mockResolvedValue([])
    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    await sessionStream()

    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('logs the unresolved-project exit message when no project can be resolved', async () => {
    mockListContainers.mockResolvedValue([])
    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sessionStream()

    expect(logSpy).toHaveBeenCalledWith('No projects found. Add one with: yaac project add <remote-url>')
    expect(logSpy).toHaveBeenCalledWith('No project selected. Exiting session stream.')
    expect(logSpy).not.toHaveBeenCalledWith(
      'Closed blank session and found no waiting sessions. Exiting session stream.',
    )
  })

  it('logs the unresolved-project exit message when project selection is invalid', async () => {
    let callCount = 0
    mockListContainers.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve([])
      if (callCount === 2) {
        return Promise.resolve([
          {
            State: 'running',
            Names: ['/yaac-a-abc'],
            Labels: { 'yaac.session-id': 'abc', 'yaac.project': 'proj-a', 'yaac.tool': 'claude' },
            Created: 1000,
            Id: '1',
          },
          {
            State: 'running',
            Names: ['/yaac-b-def'],
            Labels: { 'yaac.session-id': 'def', 'yaac.project': 'proj-b', 'yaac.tool': 'claude' },
            Created: 2000,
            Id: '2',
          },
        ] as never)
      }
      return Promise.resolve([])
    })
    mockIsTmuxAlive.mockReturnValue(true)

    const mockQuestion = vi.fn().mockResolvedValue('99')
    mockCreateInterface.mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sessionStream()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('Invalid selection.')
    expect(logSpy).toHaveBeenCalledWith('No project selected. Exiting session stream.')
    expect(logSpy).not.toHaveBeenCalledWith(
      'Closed blank session and found no waiting sessions. Exiting session stream.',
    )
  })
})

describe('promptForProject', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns undefined for empty list', async () => {
    expect(await promptForProject([], 'pick one')).toBeUndefined()
  })

  it('returns selected project by number', async () => {
    const mockQuestion = vi.fn().mockResolvedValue('2')
    mockCreateInterface.mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never)

    const result = await promptForProject(['a', 'b', 'c'], 'pick one')
    expect(result).toBe('b')
  })

  it('returns undefined for invalid selection', async () => {
    const mockQuestion = vi.fn().mockResolvedValue('99')
    mockCreateInterface.mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never)

    const result = await promptForProject(['a', 'b'], 'pick one')
    expect(result).toBeUndefined()
  })
})
