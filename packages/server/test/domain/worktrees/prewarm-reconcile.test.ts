import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#domain/worktrees/create', () => ({
  createWorktree: vi.fn(),
}))
vi.mock('#domain/worktrees/spare-pool', () => ({
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#domain/worktrees/cleanup', () => ({
  // The AWAITED teardown: the reap removes the spare's checkout off the back
  // of it, so it must not resolve before the Job is actually gone.
  cleanupWorktree: vi.fn().mockResolvedValue(true),
  deleteWorktreeState: vi.fn().mockResolvedValue(true),
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#records/preferences', () => ({ getDefaultTool: vi.fn() }))
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listWorktreePods: vi.fn(),
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { reconcilePrewarmPool } from '#domain/worktrees/prewarm-reconcile'
// `claiming` and `inFlight` are the module's shared state, read here to set
// up a mid-claim / mid-spawn cluster and asserted on afterwards.
import { claiming, inFlight, clearPrewarmStateForTests } from '#domain/worktrees/prewarm'
import { LABEL_PREWARMED, listWorktreePods, type PodInfo } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { createWorktree } from '#domain/worktrees/create'
import { cleanupWorktree, deleteWorktreeState } from '#domain/worktrees/cleanup'
import { getDefaultTool } from '#records/preferences'

const mockListPods = vi.mocked(listWorktreePods)
const mockCreate = vi.mocked(createWorktree)
const mockCleanup = vi.mocked(cleanupWorktree)
const mockDeleteState = vi.mocked(deleteWorktreeState)
const mockDefaultTool = vi.mocked(getDefaultTool)

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function pod(o: Partial<PodInfo> & { prewarmed?: boolean } = {}): PodInfo {
  const { prewarmed, ...rest } = o
  return {
    jobName: 'yaac-p-s1',
    podName: 'yaac-p-s1-x',
    worktreeId: 's1',
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
    // Both report success by default: the reap chain gates each step on the
    // one before it, so a falsy default would silently skip the deletions
    // every case here is about.
    mockCleanup.mockResolvedValue(true)
    mockDeleteState.mockResolvedValue(true)
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('spawns a prewarmed spare for an active project', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a spare for an idle project', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', worktreeId: 's2', prewarmed: true })])
    await reconcilePrewarmPool('claude')
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectSlug: 'p', worktreeId: 's2' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('removes the reaped spare\'s worktree state only once its pod is gone', async () => {
    // The order is the point. A spare's checkout is deleted off the back of
    // its teardown, and the detached teardown resolves before its Job delete
    // has even started — so doing this off THAT would remove /workspace from
    // under a pod still mounting it, and a crash in the window would leave a
    // claimable labeled spare with no checkout at all.
    const order: string[] = []
    let releaseTeardown = (): void => { /* replaced below */ }
    mockCleanup.mockImplementation(async () => {
      order.push('teardown-started')
      await new Promise<void>((r) => { releaseTeardown = r })
      order.push('teardown-done')
      return true
    })
    mockDeleteState.mockImplementation(() => { order.push('state-deleted'); return Promise.resolve(true) })
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', worktreeId: 's2', prewarmed: true })])

    await reconcilePrewarmPool('claude')
    await flush()
    // The tick does not wait on the teardown, so a slow one never stalls the
    // pool — but nothing has been deleted yet either.
    expect(order).toEqual(['teardown-started'])

    releaseTeardown()
    await flush()
    expect(order).toEqual(['teardown-started', 'teardown-done', 'state-deleted'])
    expect(mockDeleteState).toHaveBeenCalledWith('p', 's2')
  })

  it('keeps the checkout when the teardown could not confirm the pod is gone', async () => {
    // A Job delete that timed out leaves a pod in its grace period still
    // writing to /workspace. The spare keeps its flagged row, which is what
    // lets the startup sweep recognize the checkout and try again.
    mockCleanup.mockResolvedValue(false)
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', worktreeId: 's3', prewarmed: true })])

    await reconcilePrewarmPool('claude')
    await flush()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockDeleteState).not.toHaveBeenCalled()
  })

  it('is a no-op when the pool size is 0', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
    await reconcilePrewarmPool('claude')
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('does not double-spawn across ticks while a spawn is in flight', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })])
    mockCreate.mockReturnValue(new Promise<never>(() => { /* never resolves */ }))
    await reconcilePrewarmPool('claude')
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight counter when a spawn throws', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })])
    mockCreate.mockRejectedValue(new Error('boom'))
    await reconcilePrewarmPool('claude')
    await flush()
    expect(inFlight.size).toBe(0)
  })

  it('reads pods from the tick snapshot when one is provided', async () => {
    const snapshot = {
      resync: true,
      pods: vi.fn().mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })]),
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
      pod({ jobName: 'yaac-p-real', worktreeId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', worktreeId: 's2', prewarmed: true }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('refills behind a spare that is mid-claim, and never reaps it', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', worktreeId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', worktreeId: 's2', prewarmed: true }),
    ])
    claiming.add('yaac-p-spare')
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('counts a still-pending spare toward the pool (no over-spawn)', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', worktreeId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', worktreeId: 's2', prewarmed: true, running: false, phase: 'Pending' }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a wrong-tool spare in the pool (tool-agnostic; retooled at claim time)', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', worktreeId: 'r1' }),
      pod({ jobName: 'yaac-p-codex', worktreeId: 's2', tool: 'codex', prewarmed: true }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('fills the pool to the configured size', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })])
    await reconcilePrewarmPool('claude')
    expect(mockCreate.mock.calls).toEqual([
      ['p', { tool: 'claude', prewarm: true }],
      ['p', { tool: 'claude', prewarm: true }],
    ])
  })

  it('reaps the oldest excess spare after the pool size is lowered', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', worktreeId: 'r1' }),
      pod({ jobName: 'yaac-p-old', worktreeId: 'old', prewarmed: true, createdAtMs: 1_000 }),
      pod({ jobName: 'yaac-p-new', worktreeId: 'new', prewarmed: true, createdAtMs: 9_000 }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-old', projectSlug: 'p', worktreeId: 'old' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('handles multiple projects independently, ignoring pods with no project', async () => {
    mockListPods.mockResolvedValue([
      pod({ jobName: 'yaac-a-real', worktreeId: 'a1', projectSlug: 'a' }),
      pod({ jobName: 'yaac-a-spare', worktreeId: 'a2', projectSlug: 'a', prewarmed: true }),
      pod({ jobName: 'yaac-b-real', worktreeId: 'b1', projectSlug: 'b' }),
      pod({ jobName: 'orphan', worktreeId: 'o1', projectSlug: '' }),
    ])
    await reconcilePrewarmPool('claude')
    expect(mockCreate.mock.calls).toEqual([['b', { tool: 'claude', prewarm: true }]])
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('falls back to claude when no default tool is configured', async () => {
    mockDefaultTool.mockResolvedValue(undefined)
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })])
    await reconcilePrewarmPool('claude')
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
  })

  it('decrements the in-flight count per settled spawn, clearing it at zero', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', worktreeId: 'r1' })])
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
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', worktreeId: 's2', prewarmed: true })])
    mockCleanup.mockRejectedValue(new Error('pod gone'))
    await expect(reconcilePrewarmPool('claude')).resolves.toBeUndefined()
    await flush()
  })
})
