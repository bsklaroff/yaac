import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as podsModule from '@/lib/k8s/pods'
import type { TmuxLiveness } from '@/lib/session/cleanup'

vi.mock('@/lib/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual, listSessionPods: vi.fn(), listSessionJobs: vi.fn() }
})

// probeTmuxLiveness is the injected liveness oracle; cleanupSessionDetached
// is the destructive action we assert (does/doesn't fire).
vi.mock('@/lib/session/cleanup', () => ({
  probeTmuxLiveness: vi.fn(),
  cleanupSessionDetached: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/daemon/log', () => ({ daemonLog: vi.fn() }))

import { listSessionPods, listSessionJobs } from '@/lib/k8s/pods'
import { probeTmuxLiveness, cleanupSessionDetached } from '@/lib/session/cleanup'
import { daemonLog } from '@/daemon/log'
import { reconcileStaleSessions } from '@/lib/session/list'

const mockListPods = vi.mocked(listSessionPods)
const mockListJobs = vi.mocked(listSessionJobs)
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockCleanup = vi.mocked(cleanupSessionDetached)
const mockLog = vi.mocked(daemonLog)

// createdAtMs=1 (epoch) is always older than any grace window.
function pod(sessionId: string, running = true): podsModule.SessionPod {
  return {
    jobName: `yaac-proj-${sessionId}`,
    podName: `yaac-proj-${sessionId}-x1`,
    sessionId,
    projectSlug: 'proj',
    tool: 'claude',
    phase: running ? 'Running' : 'Failed',
    running,
    createdAtMs: 1,
    labels: {},
  }
}

function loggedLines(): string {
  return mockLog.mock.calls.map(([m]) => m).join('\n')
}

describe('reconcileStaleSessions', () => {
  beforeEach(() => {
    mockListPods.mockReset()
    mockListJobs.mockReset().mockResolvedValue([])
    mockProbe.mockReset()
    mockCleanup.mockClear()
    mockLog.mockClear()
  })

  it('reaps a running pod whose tmux is conclusively dead, and audits it', async () => {
    mockListPods.mockResolvedValue([pod('zombie-1')])
    mockProbe.mockResolvedValue('dead' as TmuxLiveness)

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'zombie-1', jobName: 'yaac-proj-zombie-1' }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=zombie-1')
    expect(log).toContain('tmux gone')
  })

  it('does NOT reap on an inconclusive probe, and logs the near-miss', async () => {
    mockListPods.mockResolvedValue([pod('blip-1')])
    mockProbe.mockResolvedValue('unknown' as TmuxLiveness)

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
    const log = loggedLines()
    expect(log).toContain('keeping session=blip-1')
    expect(log).toContain('inconclusive')
  })

  it('keeps a pod with a live tmux untouched and unlogged', async () => {
    mockListPods.mockResolvedValue([pod('healthy-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(loggedLines()).toBe('')
  })

  it('reaps an orphan Job that has no backing pod, and labels the reason', async () => {
    mockListPods.mockResolvedValue([])
    mockListJobs.mockResolvedValue([
      { jobName: 'yaac-proj-orphan-1', sessionId: 'orphan-1', projectSlug: 'proj', createdAtMs: 1 },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'orphan-1', jobName: 'yaac-proj-orphan-1' }),
    )
    expect(loggedLines()).toContain('orphan Job')
  })

  it('returns quietly when pod listing fails (no throw, no reap)', async () => {
    mockListPods.mockRejectedValue(new Error('cluster offline'))

    await expect(reconcileStaleSessions()).resolves.toBeUndefined()
    expect(mockCleanup).not.toHaveBeenCalled()
  })
})
