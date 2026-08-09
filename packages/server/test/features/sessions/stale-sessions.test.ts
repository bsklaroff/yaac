import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as podsModule from '#platform/k8s/pods'
import type { TmuxLiveness } from '#features/status/liveness'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual, listSessionPods: vi.fn(), listSessionJobs: vi.fn() }
})

// probeTmuxLiveness / probeAgentPaneState are the injected oracles;
// cleanupSessionDetached is the destructive action we assert (does/doesn't
// fire).
vi.mock('#features/status/liveness', () => ({
  probeTmuxLiveness: vi.fn(),
  probeAgentPaneState: vi.fn(),
}))
vi.mock('#features/sessions/cleanup', () => ({
  cleanupSessionDetached: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#log', () => ({ serverLog: vi.fn() }))

// The reaper reads session rows to tell a yaac-issued delete (whose
// in-memory terminating mark was lost) from a real out-of-band delete —
// stub it so these tests never open a DB.
vi.mock('#features/sessions/provisioning', () => ({ listProvisioning: vi.fn(() => []) }))

import { listSessionPods, listSessionJobs } from '#platform/k8s/pods'
import { probeTmuxLiveness, probeAgentPaneState } from '#features/status/liveness'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { markSessionTerminating, _clearTerminatingForTests } from '#features/status/terminating'
import { listProvisioning } from '#features/sessions/provisioning'
import { serverLog } from '#log'
import { onHerdEvent, _resetHerdEventsForTests } from '#herd-events'
import { publishDesiredWorkspaces, _resetDesiredWorkspacesForTests } from '#herd-desired'
import type { DesiredWorkspaces, HerdEvent } from '@yaac/shared/herd'
import {
  reconcileStaleSessions,
  _clearMissingPodTimersForTests,
} from '#features/sessions/stale-sessions'

const mockListPods = vi.mocked(listSessionPods)
const mockListJobs = vi.mocked(listSessionJobs)
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockPaneProbe = vi.mocked(probeAgentPaneState)
const mockCleanup = vi.mocked(cleanupSessionDetached)
// The reaper is told what exists rather than reading rows, and reports a
// death rather than writing one — so the desired set is published directly
// and the sink stands in for the server.
const herdEvents: HerdEvent[] = []
const stopsReported = (): Array<[string, string, unknown]> => herdEvents
  .filter((e) => e.type === 'worktree-stopped')
  .map((e) => [e.projectSlug, e.worktreeId, e.cause])
const setDesired = (d: Partial<DesiredWorkspaces>): void =>
  publishDesiredWorkspaces({ live: [], stopped: [], ...d })
const mockListProvisioning = vi.mocked(listProvisioning)
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
    herdEvents.length = 0
    onHerdEvent((event) => {
      herdEvents.push(event)
      return Promise.resolve()
    })
    setDesired({})
    mockListProvisioning.mockReset().mockReturnValue([])
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

  it('keeps a not-yet-Running pod past grace while its create is still provisioning', async () => {
    // A pod still pulling its image or mounting its hostPaths carries no
    // terminal state, so the classifier reads it as `pod-stopped`. Reaping
    // it deletes the session dir the starting pod is mounting.
    mockListPods.mockResolvedValue([pod('starting-1', false)])
    mockListJobs.mockResolvedValue([
      { jobName: 'yaac-proj-starting-1', sessionId: 'starting-1', projectSlug: 'proj', createdAtMs: 1 },
    ])
    mockListProvisioning.mockReturnValue([
      { worktreeId: 'starting-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Creating session job…', createdAt: '2026-08-01 00:00:00' },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a not-yet-Running pod once its create has failed', async () => {
    // A failed row lingers until dismissed, so it must not shield the
    // session the create already rolled back.
    mockListPods.mockResolvedValue([pod('failed-1', false)])
    mockListProvisioning.mockReturnValue([
      { worktreeId: 'failed-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Creating session job…', error: 'pod never started', createdAt: '2026-08-01 00:00:00' },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'failed-1', cause: { reason: 'pod-stopped' } }),
    )
  })

  it('keeps an orphan Job whose pod has not been admitted yet while its create is in flight', async () => {
    mockListPods.mockResolvedValue([])
    mockListJobs.mockResolvedValue([
      { jobName: 'yaac-proj-pending-1', sessionId: 'pending-1', projectSlug: 'proj', createdAtMs: 1 },
    ])
    mockListProvisioning.mockReturnValue([
      { worktreeId: 'pending-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Creating session job…', createdAt: '2026-08-01 00:00:00' },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
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

  it('keeps a terminating pod past grace while its create is still provisioning', async () => {
    // create's own retry loop deletes the Job between attempts; the pod it
    // is about to recreate must not be torn down underneath it.
    mockListPods.mockResolvedValue([{ ...pod('retrying-1'), terminating: true }])
    mockListProvisioning.mockReturnValue([
      { worktreeId: 'retrying-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Creating session job…', createdAt: '2026-08-01 00:00:00' },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // The split cannot be made without a published set, and the safe side is
  // "ours": restamping would overwrite a plain user delete or an earlier
  // reaped death with "removed outside yaac". Silence preserves.
  it('preserves the recorded cause when nothing has been published', async () => {
    _resetDesiredWorkspacesForTests()
    mockListPods.mockResolvedValue([{ ...pod('term-unknown'), terminating: true }])

    await reconcileStaleSessions()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'term-unknown',
        preserveDeletedRecord: true,
      }),
    )
    expect(loggedLines()).not.toContain('terminating out-of-band past grace')
  })

  it('does NOT mislabel a yaac-deleted terminating pod whose mark was lost', async () => {
    // Same pod state as the out-of-band case (terminating, no in-memory mark:
    // dropped by a restart or the TTL), but the row's recorded stoppedAt
    // proves yaac issued this delete. Resume teardown WITHOUT restamping so
    // the real cause (a plain user delete) survives — no "removed outside
    // yaac".
    mockListPods.mockResolvedValue([{ ...pod('term-ours'), terminating: true }])
    setDesired({ stopped: ['proj/term-ours'] })

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

  it('keeps a placeholder pane past grace while its create is still provisioning', async () => {
    mockListPods.mockResolvedValue([pod('warming-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')
    mockListProvisioning.mockReturnValue([
      { worktreeId: 'warming-1', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Warming…', createdAt: '2026-08-01 00:00:00' },
    ])

    await reconcileStaleSessions()

    expect(mockCleanup).not.toHaveBeenCalled()
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
      resync: true,
      pods: vi.fn().mockResolvedValue([pod('zombie-1')]),
      jobs: vi.fn().mockResolvedValue([]),
      vclusters: vi.fn(),
      vclusterPods: vi.fn(() => Promise.resolve([])),
      vclusterServices: vi.fn(() => Promise.resolve([])),
      vclusterConfigMaps: vi.fn(() => Promise.resolve([])),
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

  describe('rows whose pod is missing', () => {
    const row = (worktreeId: string, ran = false) => ({
      projectSlug: 'proj',
      worktreeId,
      ran,
    })

    beforeEach(() => {
      _clearMissingPodTimersForTests()
      vi.useFakeTimers({ toFake: ['Date'] })
    })
    afterEach(() => vi.useRealTimers())

    /** Advance the clock past the grace and tick again. */
    async function tickPastGrace(): Promise<void> {
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await reconcileStaleSessions()
    }

    it('records nothing on the first tick a pod is missing', async () => {
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleSessions()

      expect(stopsReported()).toEqual([])
    })

    it('records an abandoned create once it has stayed podless for the window', async () => {
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleSessions()
      await tickPastGrace()

      expect(stopsReported()).toEqual([
          ['proj', 'abandoned', { reason: 'never-started', detail: 'session create did not complete' }],
        ])
    })

    it('calls a session that ran orphaned, not never-started', async () => {
      // A captured prompt or transcript path proves the agent got going, so
      // its Job went away out-of-band rather than never arriving.
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('had-history', true)] })

      await reconcileStaleSessions()
      await tickPastGrace()

      expect(stopsReported()).toEqual([
          ['proj', 'had-history', { reason: 'orphaned', detail: 'Job and pod deleted out-of-band' }],
        ])
    })

    it('a single empty-but-successful pod listing condemns nothing', async () => {
      // The dangerous case: an informer cache before its initial sync
      // returns [] without throwing. Every long-lived session looks podless
      // for one tick, and nothing un-marks a death but a restart.
      setDesired({ live: [row('old-1', true), row('old-2', true)] })
      mockListPods.mockResolvedValue([pod('old-1'), pod('old-2')])
      mockProbe.mockResolvedValue('alive' as TmuxLiveness)
      await reconcileStaleSessions()

      mockListPods.mockResolvedValue([]) // the bad listing
      await reconcileStaleSessions()

      // …and the pods are back on the next tick, well before the window.
      mockListPods.mockResolvedValue([pod('old-1'), pod('old-2')])
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await reconcileStaleSessions()

      expect(stopsReported()).toEqual([])
    })

    it('exempts a session this process is still provisioning', async () => {
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('slow-build')] })
      mockListProvisioning.mockReturnValue([
        { worktreeId: 'slow-build', projectSlug: 'proj', tool: 'claude', kind: 'create', message: 'Building…', createdAt: '2026-08-01 00:00:00' },
      ])

      await reconcileStaleSessions()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    // A herd that has been told nothing must reap nothing: an empty set would
    // condemn every running workspace at once, and nothing un-marks a death.
    it('stands down entirely until the server has published a set', async () => {
      _resetDesiredWorkspacesForTests()
      mockListPods.mockResolvedValue([])

      await reconcileStaleSessions()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    it('leaves a row alone while its pod is running', async () => {
      mockListPods.mockResolvedValue([pod('healthy')])
      mockProbe.mockResolvedValue('alive' as TmuxLiveness)
      setDesired({ live: [row('healthy', true)] })

      await reconcileStaleSessions()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })
  })
})
