import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('#features/sessions/create', () => ({
  createSession: vi.fn(),
  shellEscape: (s: string) => s,
}))
vi.mock('#features/sessions/cleanup', () => ({
  cleanupSessionDetached: vi.fn(),
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#features/projects/preferences', () => ({ getDefaultTool: vi.fn() }))
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn(),
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { reconcilePrewarmPool } from '#features/images/prewarm-reconcile'
import { inFlight, clearPrewarmStateForTests } from '#features/images/prewarm'
import { LABEL_PREWARMED, listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { createSession } from '#features/sessions/create'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { getDefaultTool } from '#features/projects/preferences'

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
    mockCreate.mockResolvedValue({ sessionId: 's', jobName: 'yaac-p-s', forwardedPorts: [], tool: 'claude' })
    mockCleanup.mockResolvedValue(undefined)
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('spawns a prewarmed spare for an active project', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    await reconcilePrewarmPool()
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a spare for an idle project', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-spare', sessionId: 's2', prewarmed: true })])
    await reconcilePrewarmPool()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectSlug: 'p', sessionId: 's2' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is a no-op when the pool size is 0', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
    await reconcilePrewarmPool()
    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('does not double-spawn across ticks while a spawn is in flight', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    mockCreate.mockReturnValue(new Promise<never>(() => { /* never resolves */ }))
    await reconcilePrewarmPool()
    await reconcilePrewarmPool()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight counter when a spawn throws', async () => {
    mockListPods.mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })])
    mockCreate.mockRejectedValue(new Error('boom'))
    await reconcilePrewarmPool()
    await flush()
    expect(inFlight.size).toBe(0)
  })

  it('reads pods from the tick snapshot when one is provided', async () => {
    const snapshot = {
      pods: vi.fn().mockResolvedValue([pod({ jobName: 'yaac-p-real', sessionId: 'r1' })]),
      jobs: vi.fn(),
      vclusters: vi.fn(),
    }
    await reconcilePrewarmPool(snapshot)
    expect(mockListPods).not.toHaveBeenCalled()
    expect(snapshot.pods).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith('p', { tool: 'claude', prewarm: true })
  })
})
