import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as podsModule from '#platform/k8s/pods'
import type { TmuxLiveness } from '#features/status/liveness'

vi.mock('#platform/k8s/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual, listWorktreePods: vi.fn(), listWorktreeJobs: vi.fn() }
})

// probeTmuxLiveness / probeAgentPaneState are the injected oracles;
// cleanupWorktreeDetached is the destructive action we assert (does/doesn't
// fire).
vi.mock('#features/status/liveness', () => ({
  probeTmuxLiveness: vi.fn(),
  probeAgentPaneState: vi.fn(),
}))
vi.mock('#features/worktrees/cleanup', () => ({
  cleanupWorktreeDetached: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#log', () => ({ serverLog: vi.fn() }))

// The reaper reads session rows to tell a yaac-issued delete (whose
// in-memory terminating mark was lost) from a real out-of-band delete —
// stub it so these tests never open a DB.

import { listWorktreePods, listWorktreeJobs } from '#platform/k8s/pods'
import { probeTmuxLiveness, probeAgentPaneState } from '#features/status/liveness'
import { cleanupWorktreeDetached } from '#features/worktrees/cleanup'
import { markWorktreeTerminating, _clearTerminatingForTests } from '#features/status/terminating'
import { serverLog } from '#log'
import { _setServerLinkForTests } from '#server-link'
import { publishDesiredWorkspaces, _resetDesiredWorkspacesForTests } from '#herd-desired'
import type { DesiredWorkspaces, HerdEvent } from '@yaac/shared/herd'
import {
  reconcileStaleWorktrees,
  _clearMissingPodTimersForTests,
  _resetStaleReaperForTests,
} from '#features/worktrees/stale-worktrees'

const mockListPods = vi.mocked(listWorktreePods)
const mockListJobs = vi.mocked(listWorktreeJobs)
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockPaneProbe = vi.mocked(probeAgentPaneState)
const mockCleanup = vi.mocked(cleanupWorktreeDetached)
// The reaper is told what exists rather than reading rows, and reports a
// death rather than writing one — so the desired set is published directly
// and the sink stands in for the server.
const herdEvents: HerdEvent[] = []
const stopsReported = (): Array<[string, string, unknown]> => herdEvents
  .filter((e) => e.type === 'worktree-stopped')
  .map((e) => [e.projectSlug, e.worktreeId, e.cause])
// Every real pass publishes a desired set before the reaper runs, and the
// reaper stands down on a pass whose publish did not land — so a test that
// ticks twice has to publish twice, exactly as the loop does.
let lastDesired: DesiredWorkspaces = { live: [], stopped: [], provisioning: [] }
const setDesired = (d: Partial<DesiredWorkspaces>): void => {
  lastDesired = { live: [], stopped: [], provisioning: [], ...d }
  publishDesiredWorkspaces(lastDesired)
}
/** The next pass, with the same set republished. */
const republish = (): void => publishDesiredWorkspaces(lastDesired)
const mockLog = vi.mocked(serverLog)

// createdAtMs=1 (epoch) is always older than any grace window.
function pod(worktreeId: string, running = true): podsModule.PodInfo {
  return {
    jobName: `yaac-proj-${worktreeId}`,
    podName: `yaac-proj-${worktreeId}-x1`,
    worktreeId,
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

describe('reconcileStaleWorktrees', () => {
  beforeEach(() => {
    _resetDesiredWorkspacesForTests()
    _resetStaleReaperForTests()
    mockListPods.mockReset()
    mockListJobs.mockReset().mockResolvedValue([])
    mockProbe.mockReset()
    mockPaneProbe.mockReset().mockResolvedValue('started')
    mockCleanup.mockClear()
    herdEvents.length = 0
    _setServerLinkForTests({
      workspaceEvent: (event) => {
        herdEvents.push(event)
        return Promise.resolve()
      },
    })
    setDesired({})
    mockLog.mockClear()
    _clearTerminatingForTests()
  })

  it('reaps a running pod whose tmux is conclusively dead, and audits it', async () => {
    mockListPods.mockResolvedValue([pod('zombie-1')])
    mockProbe.mockResolvedValue('dead' as TmuxLiveness)

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'zombie-1',
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

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'oomed-1',
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
      { jobName: 'yaac-proj-starting-1', worktreeId: 'starting-1', projectSlug: 'proj', createdAtMs: 1 },
    ])
    setDesired({ provisioning: ['starting-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a not-yet-Running pod once its create has failed', async () => {
    // A failed row lingers until dismissed, so it must not shield the
    // session the create already rolled back.
    mockListPods.mockResolvedValue([pod('failed-1', false)])
    // A failed create is not reported as in flight (see inFlightWorktreeIds),
    // so nothing shields 'failed-1'.
    setDesired({ provisioning: [] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'failed-1', cause: { reason: 'pod-stopped' } }),
    )
  })

  it('keeps an orphan Job whose pod has not been admitted yet while its create is in flight', async () => {
    mockListPods.mockResolvedValue([])
    mockListJobs.mockResolvedValue([
      { jobName: 'yaac-proj-pending-1', worktreeId: 'pending-1', projectSlug: 'proj', createdAtMs: 1 },
    ])
    setDesired({ provisioning: ['pending-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive probe, and logs the near-miss', async () => {
    mockListPods.mockResolvedValue([pod('blip-1')])
    mockProbe.mockResolvedValue('unknown' as TmuxLiveness)

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
    const log = loggedLines()
    expect(log).toContain('keeping session=blip-1')
    expect(log).toContain('inconclusive')
  })

  it('keeps a pod with a live tmux untouched and unlogged', async () => {
    mockListPods.mockResolvedValue([pod('healthy-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(loggedLines()).toBe('')
  })

  it('reaps an out-of-band terminating pod past grace that we did not mark', async () => {
    // deletionTimestamp set (terminating), never entered our registry, and no
    // deleted-store row — a genuine external delete stuck past grace. Re-issue
    // the idempotent teardown and stamp the out-of-band cause.
    mockListPods.mockResolvedValue([{ ...pod('term-1'), terminating: true }])

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'term-1',
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
    setDesired({ provisioning: ['retrying-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // Every sweep here needs the set — the cause split would restamp a plain
  // user delete as "removed outside yaac" without it, and the exemption set
  // would be empty — so a pass with no publish reaps nothing at all rather
  // than reaping on the half of the set it can still read.
  it('stands down entirely when nothing has been published', async () => {
    _resetDesiredWorkspacesForTests()
    _resetStaleReaperForTests()
    mockListPods.mockResolvedValue([{ ...pod('term-unknown'), terminating: true }])

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(stopsReported()).toEqual([])
  })

  // A set the LAST pass published is no better: an exemption one pass old
  // can miss a create started since, and that set is the only thing between
  // these sweeps and a workspace being built right now.
  it('stands down on a pass whose publish did not land', async () => {
    mockListPods.mockResolvedValue([{ ...pod('term-stuck'), terminating: true }])
    setDesired({})
    await reconcileStaleWorktrees()
    mockCleanup.mockClear()

    // Second pass, no publish (the step threw): same pods, no reaping.
    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT mislabel a yaac-deleted terminating pod whose mark was lost', async () => {
    // Same pod state as the out-of-band case (terminating, no in-memory mark:
    // dropped by a restart or the TTL), but the row's recorded stoppedAt
    // proves yaac issued this delete. Resume teardown WITHOUT restamping so
    // the real cause (a plain user delete) survives — no "removed outside
    // yaac".
    mockListPods.mockResolvedValue([{ ...pod('term-ours'), terminating: true }])
    setDesired({ stopped: ['proj/term-ours'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'term-ours',
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
    markWorktreeTerminating('term-2')
    mockListPods.mockResolvedValue([{ ...pod('term-2'), terminating: true }])

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a live-tmux pod whose agent pane is still the placeholder past grace', async () => {
    mockListPods.mockResolvedValue([pod('half-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'half-1', jobName: 'yaac-proj-half-1' }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=half-1')
    expect(log).toContain('agent never started')
  })

  it('keeps a placeholder pane past grace while its create is still provisioning', async () => {
    mockListPods.mockResolvedValue([pod('warming-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')
    setDesired({ provisioning: ['warming-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a placeholder pane while the pod is inside the grace window', async () => {
    const fresh = { ...pod('fresh-1'), createdAtMs: Date.now() }
    mockListPods.mockResolvedValue([fresh])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive agent-pane probe', async () => {
    mockListPods.mockResolvedValue([pod('pane-blip-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('unknown')

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps an orphan Job that has no backing pod, and labels the reason', async () => {
    mockListPods.mockResolvedValue([])
    mockListJobs.mockResolvedValue([
      { jobName: 'yaac-proj-orphan-1', worktreeId: 'orphan-1', projectSlug: 'proj', createdAtMs: 1 },
    ])

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'orphan-1',
        jobName: 'yaac-proj-orphan-1',
        cause: { reason: 'orphaned' },
      }),
    )
    expect(loggedLines()).toContain('orphan Job')
  })

  it('returns quietly when pod listing fails (no throw, no reap)', async () => {
    mockListPods.mockRejectedValue(new Error('cluster offline'))

    await expect(reconcileStaleWorktrees()).resolves.toBeUndefined()
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

    await reconcileStaleWorktrees(snapshot)

    expect(mockListPods).not.toHaveBeenCalled()
    expect(mockListJobs).not.toHaveBeenCalled()
    expect(snapshot.pods).toHaveBeenCalledTimes(1)
    expect(snapshot.jobs).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'zombie-1' }),
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
      republish()
      await reconcileStaleWorktrees()
    }

    it('records nothing on the first tick a pod is missing', async () => {
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorktrees()

      expect(stopsReported()).toEqual([])
    })

    it('records an abandoned create once it has stayed podless for the window', async () => {
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorktrees()
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

      await reconcileStaleWorktrees()
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
      await reconcileStaleWorktrees()

      mockListPods.mockResolvedValue([]) // the bad listing
      await reconcileStaleWorktrees()

      // …and the pods are back on the next tick, well before the window.
      mockListPods.mockResolvedValue([pod('old-1'), pod('old-2')])
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await reconcileStaleWorktrees()

      expect(stopsReported()).toEqual([])
    })

    it('exempts a session this process is still provisioning', async () => {
      mockListPods.mockResolvedValue([])
      setDesired({ live: [row('slow-build')], provisioning: ['slow-build'] })

      await reconcileStaleWorktrees()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    // A herd that has been told nothing must reap nothing: an empty set would
    // condemn every running workspace at once, and nothing un-marks a death.
    it('stands down entirely until the server has published a set', async () => {
      _resetDesiredWorkspacesForTests()
      mockListPods.mockResolvedValue([])

      await reconcileStaleWorktrees()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    it('leaves a row alone while its pod is running', async () => {
      mockListPods.mockResolvedValue([pod('healthy')])
      mockProbe.mockResolvedValue('alive' as TmuxLiveness)
      setDesired({ live: [row('healthy', true)] })

      await reconcileStaleWorktrees()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })
  })
})
