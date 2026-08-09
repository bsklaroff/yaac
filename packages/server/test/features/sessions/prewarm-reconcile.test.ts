import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#features/sessions/create', () => ({
  createSession: vi.fn(),
}))
vi.mock('#features/sessions/spare-pool', () => ({
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#features/sessions/cleanup', () => ({
  cleanupSessionDetached: vi.fn(),
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#features/records/preferences', () => ({ getDefaultTool: vi.fn() }))
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn(),
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { reconcilePrewarmPool } from '#features/sessions/prewarm-reconcile'
// `claiming` and `inFlight` are the module's shared state, read here to set
// up a mid-claim / mid-spawn cluster and asserted on afterwards.
import { claiming, inFlight, clearPrewarmStateForTests } from '#features/sessions/prewarm'
import { LABEL_PREWARMED, listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { createSession } from '#features/sessions/create'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { getDefaultTool } from '#features/records/preferences'

const mockListPods = vi.mocked(listSessionPods)
const mockCreate = vi.mocked(createSession)
const mockCleanup = vi.mocked(cleanupSessionDetached)
const mockDefaultTool = vi.mocked(getDefaultTool)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function pod(o: Partial<SessionPod> & { prewarmed?: boolean } = {}): SessionPod {
  const { prewarmed, ...rest } = o
  return {
    jobName: 'yaac-p-s1',
    podName: 'yaac-p-s1-x',
    sessionId: 's1',
    projectSlug: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_000,
    labels: prewarmed ? { [LABEL_PREWARMED]: 'true' } : {},
    ...rest,
  }
}

describe('reconcilePrewarmPool', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    mockDefaultTool.mockResolvedValue('claude')
    mockCreate.mockResolvedValue({ worktreeId: 's', jobName: 'yaac-p-s', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
    mockCleanup.mockResolvedValue(undefined)
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('spawns a prewarmed spare for an active project', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a spare for an idle project', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true })])
    await reconcilePrewarmPool('claude')
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectSlug: 'p', sessionId: 's2' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is a no-op when the pool size is 0', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
    await reconcilePrewarmPool('claude')
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('does not double-spawn across ticks while a spawn is in flight', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    mockCreate.mockReturnValue(new Promise<never>(() => { /* never resolves */ }))
    await reconcilePrewarmPool('claude')
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight counter when a spawn throws', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    mockCreate.mockRejectedValue(new Error('boom'))
    await reconcilePrewarmPool('claude')
    await flush()
    expect(inFlight.size).toBe(0)
  })

  it('reads pods from the tick snapshot when one is provided', async () => {
    const snapshot = {
      resync: true,
      pods: vi.fn().mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })]),
      jobs: vi.fn(),
      vclusters: vi.fn(),
      vclusterPods: vi.fn(() => Promise.resolve([])),
      vclusterServices: vi.fn(() => Promise.resolve([])),
      vclusterConfigMaps: vi.fn(() => Promise.resolve([])),
    }
    await reconcilePrewarmPool('claude', snapshot)
    expect(mockListPods).not.toHaveBeenCalled()
    expect(snapshot.pods).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
  })

  it('does nothing for an empty cluster', async () => {
    mockListPods.mockResolvedValue([])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('skips the tick when listing pods throws', async () => {
    mockListPods.mockRejectedValue(new Error('cluster down'))
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('is a no-op once the project already has its spare', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('refills behind a spare that is mid-claim, and never reaps it', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true }),
    ])
    claiming.add('yaac-p-spare')
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('counts a still-pending spare toward the pool (no over-spawn)', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true, running: false, phase: 'Pending' }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a wrong-tool spare in the pool (tool-agnostic; retooled at claim time)', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-codex', sessionId: 's2', tool: 'codex', prewarmed: true }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('fills the pool to the configured size', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    await reconcilePrewarmPool('claude')
    expect(mockCreate.mock.calls).toEqual([
      ['p', { tool: 'claude', prewarm: true }],
      ['p', { tool: 'claude', prewarm: true }],
    ])
  })

  it('reaps the oldest excess spare after the pool size is lowered', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', sessionId: 'r1' }),
      pod({ jobName: 'yaac-p-old', sessionId: 'old', prewarmed: true, createdAtMs: 1_000 }),
      pod({ jobName: 'yaac-p-new', sessionId: 'new', prewarmed: true, createdAtMs: 9_000 }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-old', projectSlug: 'p', sessionId: 'old' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('handles multiple projects independently, ignoring pods with no project', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-a-real', sessionId: 'a1', projectSlug: 'a' }),
      pod({ jobName: 'yaac-a-spare', sessionId: 'a2', projectSlug: 'a', prewarmed: true }),
      pod({ jobName: 'yaac-b-real', sessionId: 'b1', projectSlug: 'b' }),
      pod({ jobName: 'orphan', sessionId: 'o1', projectSlug: '' }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate.mock.calls).toEqual([['b', { tool: 'claude', prewarm: true }]])
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('falls back to claude when no default tool is configured', async () => {
    mockDefaultTool.mockResolvedValue(undefined)
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
  })

  it('decrements the in-flight count per settled spawn, clearing it at zero', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    let settleFirst = (): void => { /* replaced below */ }
    mockCreate
      .mockReturnValueOnce(new Promise((resolve) => {
        settleFirst = () => resolve({ worktreeId: 's', jobName: 'yaac-p-s', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
      }))
      .mockReturnValue(new Promise<never>(() => { /* never resolves */ }))

    await reconcilePrewarmPool('claude')
    expect(inFlight.get('p')).toBe(2)

    settleFirst()
    await flush()
    // One of two settled: the counter drops rather than clearing, so the
    // next tick still sees the outstanding spawn and doesn't stampede.
    expect(inFlight.get('p')).toBe(1)
  })

  it('swallows a failed reap — the stale-session reaper retries', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true })])
    mockCleanup.mockRejectedValue(new Error('pod gone'))
    await expect(reconcilePrewarmPool('claude')).resolves.toBeUndefined()
    await flush()
  })
})
