import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as podsModule from '#platform/k8s/pods'
import type { TmuxLiveness } from '#features/sessions/cleanup'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual, listSessionPods: vi.fn(), listSessionJobs: vi.fn() }
})

// probeTmuxLiveness / probeAgentPaneState are the injected oracles;
// cleanupSessionDetached is the destructive action we assert (does/doesn't
// fire).
vi.mock('#features/sessions/cleanup', () => ({
  probeTmuxLiveness: vi.fn(),
  probeAgentPaneState: vi.fn(),
  cleanupSessionDetached: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#log', () => ({ serverLog: vi.fn() }))

// The reaper reads the deleted-store to tell a yaac-issued delete (whose
// in-memory terminating mark was lost) from a real out-of-band delete —
// stub it so these tests never open a DB.
vi.mock('#features/sessions/deleted-store', () => ({ listDeletedInfo: vi.fn() }))

import { listSessionPods, listSessionJobs } from '#platform/k8s/pods'
import { probeTmuxLiveness, probeAgentPaneState, cleanupSessionDetached } from '#features/sessions/cleanup'
import { markSessionTerminating, _clearTerminatingForTests } from '#features/sessions/terminating'
import { listDeletedInfo } from '#features/sessions/deleted-store'
import { serverLog } from '#log'
import { reconcileStaleSessions } from '#features/sessions/list'

const mockListPods = vi.mocked(listSessionPods)
const mockListJobs = vi.mocked(listSessionJobs)
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockPaneProbe = vi.mocked(probeAgentPaneState)
const mockCleanup = vi.mocked(cleanupSessionDetached)
const mockListDeletedInfo = vi.mocked(listDeletedInfo)
const mockLog = vi.mocked(serverLog)

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
    terminating: false,
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
    mockPaneProbe.mockReset().mockResolvedValue('started')
    mockCleanup.mockClear()
    mockListDeletedInfo.mockReset().mockResolvedValue(new Map())
    mockLog.mockClear()
    _clearTerminatingForTests()
  })

  it('reaps a running pod whose tmux is conclusively dead, and audits it', async () => {
    mockListPods.mockResolvedValue([pod('zombie-1')])
    mockProbe.mockResolvedValue('dead' as TmuxLiveness)

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'zombie-1',
        jobName: 'yaac-proj-zombie-1',
        cause: { reason: 'agent-exited' },
      }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=zombie-1')
    expect(log).toContain('tmux gone')
  })

  it('reaps a stopped pod with its derived death cause, and audits it', async () => {
    mockListPods.mockResolvedValue([{
      ...pod('oomed-1', false),
      terminal: { containerReason: 'OOMKilled', exitCode: 137 },
    }])

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'oomed-1',
        cause: { reason: 'oom', detail: 'exit code 137' },
      }),
    )
    expect(loggedLines()).toContain('pod stopped: oom (exit code 137)')
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

  it('reaps an out-of-band terminating pod past grace that we did not mark', async () => {
    // deletionTimestamp set (terminating), never entered our registry, and no
    // deleted-store row — a genuine external delete stuck past grace. Re-issue
    // the idempotent teardown and stamp the out-of-band cause.
    mockListPods.mockResolvedValue([{ ...pod('term-1'), terminating: true }])

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'term-1',
        jobName: 'yaac-proj-term-1',
        cause: { reason: 'orphaned', detail: 'pod deleted out-of-band' },
      }),
    )
    expect(loggedLines()).toContain('terminating out-of-band past grace')
  })

  it('does NOT mislabel a yaac-deleted terminating pod whose mark was lost', async () => {
    // Same pod state as the out-of-band case (terminating, no in-memory mark:
    // dropped by a restart or the TTL), but the durable deleted-store row
    // proves yaac issued this delete. Resume teardown WITHOUT restamping so
    // the real cause (a plain user delete) survives — no "removed outside
    // yaac".
    mockListPods.mockResolvedValue([{ ...pod('term-ours'), terminating: true }])
    mockListDeletedInfo.mockResolvedValue(new Map([
      ['term-ours', { deletedAt: new Date(0), seen: false }],
    ]))

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'term-ours',
        jobName: 'yaac-proj-term-ours',
        preserveDeletedRecord: true,
      }),
    )
    // Crucially, no out-of-band cause is forwarded.
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup.mock.calls[0][0]).not.toHaveProperty('cause')
    const log = loggedLines()
    expect(log).toContain('resuming teardown session=term-ours')
    expect(log).not.toContain('out-of-band')
  })

  it('does NOT re-reap a terminating pod whose teardown we already issued', async () => {
    markSessionTerminating('term-2')
    mockListPods.mockResolvedValue([{ ...pod('term-2'), terminating: true }])

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a live-tmux pod whose agent pane is still the placeholder past grace', async () => {
    mockListPods.mockResolvedValue([pod('half-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'half-1', jobName: 'yaac-proj-half-1' }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=half-1')
    expect(log).toContain('agent never started')
  })

  it('keeps a placeholder pane while the pod is inside the grace window', async () => {
    const fresh = { ...pod('fresh-1'), createdAtMs: Date.now() }
    mockListPods.mockResolvedValue([fresh])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive agent-pane probe', async () => {
    mockListPods.mockResolvedValue([pod('pane-blip-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('unknown')

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps an orphan Job that has no backing pod, and labels the reason', async () => {
    mockListPods.mockResolvedValue([])
    mockListJobs.mockResolvedValue([
      { jobName: 'yaac-proj-orphan-1', sessionId: 'orphan-1', projectSlug: 'proj', createdAtMs: 1 },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'orphan-1',
        jobName: 'yaac-proj-orphan-1',
        cause: { reason: 'orphaned' },
      }),
    )
    expect(loggedLines()).toContain('orphan Job')
  })

  it('returns quietly when pod listing fails (no throw, no reap)', async () => {
    mockListPods.mockRejectedValue(new Error('cluster offline'))

    await expect(reconcileStaleSessions()).resolves.toBeUndefined()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reads pods and jobs from the tick snapshot when one is provided', async () => {
    const snapshot = {
      pods: vi.fn().mockResolvedValue([pod('zombie-1')]),
      jobs: vi.fn().mockResolvedValue([]),
      vclusters: vi.fn(),
    }
    mockProbe.mockResolvedValue('dead' as TmuxLiveness)

    await reconcileStaleSessions(snapshot)

    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockListJobs).not.toHaveBeenCalled()
    expect(snapshot.pods).toHaveBeenCalledTimes(1)
    expect(snapshot.jobs).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'zombie-1' }),
    )
  })
})
