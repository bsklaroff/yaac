import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as podsModule from '#runtime/k8s/substrate/pods'
import { runtimeHandleFromPod } from '#runtime/k8s/view'
import type { RuntimeHandle, StrayUnit } from '#runtime/contract'
import { installFakeWorktreeRuntime } from '@yaac/test-utils/fake-runtime'
import type { TmuxLiveness } from '#runtime/status/liveness'

vi.mock('#runtime/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual }
})

// probeTmuxLiveness / probeAgentPaneState are the injected oracles;
// cleanupWorktreeDetached is the destructive action we assert (does/doesn't
// fire).
vi.mock('#runtime/status/liveness', () => ({
  probeTmuxLiveness: vi.fn(),
  probeAgentPaneState: vi.fn(),
}))
vi.mock('#domain/worktrees/cleanup', () => ({
  cleanupWorktreeDetached: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('#log', () => ({ serverLog: vi.fn() }))

// The reaper reads the desired set from db at the top of its pass and
// reports a death as an event rather than writing the row — both stubbed,
// so these tests never open a DB.
vi.mock('#db', () => ({
  applyWorktreeEvent: vi.fn(),
  desiredWorktrees: vi.fn(),
}))

// The reaper reads session rows to tell a yaac-issued delete (whose
// in-memory terminating mark was lost) from a real out-of-band delete —
// stub it so these tests never open a DB.

import { probeTmuxLiveness, probeAgentPaneState } from '#runtime/status/liveness'
import { cleanupWorktreeDetached } from '#domain/worktrees/cleanup'
import { markWorktreeTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { serverLog } from '#log'
import { applyWorktreeEvent, desiredWorktrees } from '#db'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/worktrees/provisioning'
import type { WorktreeEvent } from '#db'
import {
  reconcileStaleWorktrees,
  _clearMissingPodTimersForTests,
} from '#domain/worktrees/stale-worktrees'

/** What the registered runtime reports for the pass. Stray units are the
 *  view's own answer to "units with no workspace", so a case sets them
 *  directly rather than restating the pod-vs-unit cross-reference. */
const mockWorkspaces = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockStrays = vi.fn<() => Promise<StrayUnit[]>>()
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockPaneProbe = vi.mocked(probeAgentPaneState)
const mockCleanup = vi.mocked(cleanupWorktreeDetached)
// The reaper reads what should exist from db and reports a death as
// an event rather than writing the row — both stubbed above, so what a
// pass decided is asserted directly.
const appliedEvents: WorktreeEvent[] = []
const stopsReported = (): Array<[string, string, unknown]> => appliedEvents
  .filter((e) => e.type === 'worktree-stopped')
  .map((e) => [e.projectSlug, e.worktreeId, e.cause])
/** What the reaper's db read answers, plus which creates are in
 *  flight (registered in the real provisioning registry). */
interface DesiredSetup {
  live: Array<{ projectSlug: string; worktreeId: string; ran: boolean }>
  stopped: string[]
  provisioning: string[]
}
let lastDesired: DesiredSetup = { live: [], stopped: [], provisioning: [] }
const setDesired = (d: Partial<DesiredSetup>): void => {
  lastDesired = { live: [], stopped: [], provisioning: [], ...d }
  clearAllProvisioningForTests()
  for (const worktreeId of lastDesired.provisioning) {
    registerProvisioning({ worktreeId, projectSlug: 'proj', tool: 'claude', kind: 'create' })
  }
  vi.mocked(desiredWorktrees).mockResolvedValue({
    live: lastDesired.live, stopped: lastDesired.stopped,
  })
}
/** The next pass, with the same set republished. */
const mockLog = vi.mocked(serverLog)

// createdAtMs=1 (epoch) is always older than any grace window.
function pod(worktreeId: string, running = true): RuntimeHandle {
  return runtimeHandleFromPod({
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
  })
}

/** A unit the runtime still holds with no workspace behind it. */
function stray(workspaceId: string, createdAtMs = 1): StrayUnit {
  return { workspaceId, unitName: `yaac-proj-${workspaceId}`, projectSlug: 'proj', createdAtMs }
}

function loggedLines(): string {
  return mockLog.mock.calls.map(([m]) => m).join('\n')
}

describe('reconcileStaleWorktrees', () => {
  beforeEach(() => {
    mockWorkspaces.mockReset().mockResolvedValue([])
    mockStrays.mockReset().mockResolvedValue([])
    installFakeWorktreeRuntime({
      snapshot: () => ({ resync: true, workspaces: mockWorkspaces, strayUnits: mockStrays }),
    })
    mockProbe.mockReset()
    mockPaneProbe.mockReset().mockResolvedValue('started')
    mockCleanup.mockClear()
    appliedEvents.length = 0
    vi.mocked(applyWorktreeEvent).mockImplementation((event) => {
      appliedEvents.push(event)
      return Promise.resolve()
    })
    setDesired({})
    mockLog.mockClear()
    _clearTerminatingForTests()
  })

  it('reaps a running pod whose tmux is conclusively dead, and audits it', async () => {
    mockWorkspaces.mockResolvedValue([pod('zombie-1')])
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

  // The cause is derived at the runtime boundary (see the view's handle
  // mapper); what the reaper owes is carrying it through to the teardown
  // and the audit line, which is what this asserts.
  it('reaps a stopped workspace with its derived death cause, and audits it', async () => {
    mockWorkspaces.mockResolvedValue([{
      ...pod('oomed-1', false),
      deathCause: { reason: 'oom', detail: 'exit code 137' },
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
    mockWorkspaces.mockResolvedValue([pod('starting-1', false)])
    setDesired({ provisioning: ['starting-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a not-yet-Running pod once its create has failed', async () => {
    // A failed row lingers until dismissed, so it must not shield the
    // session the create already rolled back.
    mockWorkspaces.mockResolvedValue([pod('failed-1', false)])
    // A failed create is not reported as in flight (see inFlightWorktreeIds),
    // so nothing shields 'failed-1'.
    setDesired({ provisioning: [] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'failed-1', cause: { reason: 'pod-stopped' } }),
    )
  })

  it('keeps an orphan Job whose pod has not been admitted yet while its create is in flight', async () => {
    mockWorkspaces.mockResolvedValue([])
    mockStrays.mockResolvedValue([stray('pending-1')])
    setDesired({ provisioning: ['pending-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive probe, and logs the near-miss', async () => {
    mockWorkspaces.mockResolvedValue([pod('blip-1')])
    mockProbe.mockResolvedValue('unknown' as TmuxLiveness)

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
    const log = loggedLines()
    expect(log).toContain('keeping session=blip-1')
    expect(log).toContain('inconclusive')
  })

  it('keeps a pod with a live tmux untouched and unlogged', async () => {
    mockWorkspaces.mockResolvedValue([pod('healthy-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(loggedLines()).toBe('')
  })

  it('reaps an out-of-band terminating pod past grace that we did not mark', async () => {
    // deletionTimestamp set (terminating), never entered our registry, and no
    // deleted-store row — a genuine external delete stuck past grace. Re-issue
    // the idempotent teardown and stamp the out-of-band cause.
    mockWorkspaces.mockResolvedValue([{ ...pod('term-1'), terminating: true }])

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
    mockWorkspaces.mockResolvedValue([{ ...pod('retrying-1'), terminating: true }])
    setDesired({ provisioning: ['retrying-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // Every sweep here needs the set — the cause split would restamp a plain
  // user delete as "removed outside yaac" without it, and the exemption set
  // would be empty — so a pass with no publish reaps nothing at all rather
  // than reaping on the half of the set it can still read.
  // Reaping on a guess destroys uncommitted work, so a desired set that
  // cannot be read stands every sweep down — say nothing, reap nothing, and
  // the next pass retries with a fresh read.
  it('stands down entirely when the desired set cannot be read', async () => {
    mockWorkspaces.mockResolvedValue([{ ...pod('term-unknown'), terminating: true }])
    vi.mocked(desiredWorktrees).mockRejectedValue(new Error('db is gone'))

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(stopsReported()).toEqual([])
  })

  it('does NOT mislabel a yaac-deleted terminating pod whose mark was lost', async () => {
    // Same pod state as the out-of-band case (terminating, no in-memory mark:
    // dropped by a restart or the TTL), but the row's recorded stoppedAt
    // proves yaac issued this delete. Resume teardown WITHOUT restamping so
    // the real cause (a plain user delete) survives — no "removed outside
    // yaac".
    mockWorkspaces.mockResolvedValue([{ ...pod('term-ours'), terminating: true }])
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
    mockWorkspaces.mockResolvedValue([{ ...pod('term-2'), terminating: true }])

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a live-tmux pod whose agent pane is still the placeholder past grace', async () => {
    mockWorkspaces.mockResolvedValue([pod('half-1')])
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
    mockWorkspaces.mockResolvedValue([pod('warming-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')
    setDesired({ provisioning: ['warming-1'] })

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a placeholder pane while the pod is inside the grace window', async () => {
    const fresh = { ...pod('fresh-1'), createdAtMs: Date.now() }
    mockWorkspaces.mockResolvedValue([fresh])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive agent-pane probe', async () => {
    mockWorkspaces.mockResolvedValue([pod('pane-blip-1')])
    mockProbe.mockResolvedValue('alive' as TmuxLiveness)
    mockPaneProbe.mockResolvedValue('unknown')

    await reconcileStaleWorktrees()

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps an orphan Job that has no backing pod, and labels the reason', async () => {
    mockWorkspaces.mockResolvedValue([])
    mockStrays.mockResolvedValue([stray('orphan-1')])

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
    mockWorkspaces.mockRejectedValue(new Error('cluster offline'))

    await expect(reconcileStaleWorktrees()).resolves.toBeUndefined()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // The two failures stand different amounts down, and the difference is
  // the point: a workspace read that fails leaves the reaper unable to
  // judge ANY absence, but a stray-unit read that fails only blinds the
  // orphan sweep — the workspaces it did read are still conclusive about
  // themselves. Collapsing this into the read above (or into one
  // Promise.all) would silently turn a partial stand-down into a total
  // one, and nothing else in the suite would notice.
  it('stands only the orphan sweep down when the stray-unit read fails', async () => {
    mockWorkspaces.mockResolvedValue([pod('zombie-1')])
    mockStrays.mockRejectedValue(new Error('informer down'))
    mockProbe.mockResolvedValue('dead' as TmuxLiveness)

    await expect(reconcileStaleWorktrees()).resolves.toBeUndefined()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'zombie-1' }),
    )
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(loggedLines()).not.toContain('orphan Job')
  })

  it("reads the pass view it is handed, never taking the runtime's own", async () => {
    const workspaces = vi.fn().mockResolvedValue([pod('zombie-1')])
    const strayUnits = vi.fn().mockResolvedValue([])
    mockProbe.mockResolvedValue('dead' as TmuxLiveness)

    await reconcileStaleWorktrees({ resync: true, workspaces, strayUnits })

    // Taking a second view mid-pass is what the shared snapshot exists to
    // prevent: absence would then be judged against a different instant.
    expect(mockWorkspaces).not.toHaveBeenCalled()
    expect(mockStrays).not.toHaveBeenCalled()
    expect(workspaces).toHaveBeenCalledTimes(1)
    expect(strayUnits).toHaveBeenCalledTimes(1)
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
      await reconcileStaleWorktrees()
    }

    it('records nothing on the first tick a pod is missing', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorktrees()

      expect(stopsReported()).toEqual([])
    })

    it('records an abandoned create once it has stayed podless for the window', async () => {
      mockWorkspaces.mockResolvedValue([])
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
      mockWorkspaces.mockResolvedValue([])
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
      mockWorkspaces.mockResolvedValue([pod('old-1'), pod('old-2')])
      mockProbe.mockResolvedValue('alive' as TmuxLiveness)
      await reconcileStaleWorktrees()

      mockWorkspaces.mockResolvedValue([]) // the bad listing
      await reconcileStaleWorktrees()

      // …and the pods are back on the next tick, well before the window.
      mockWorkspaces.mockResolvedValue([pod('old-1'), pod('old-2')])
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await reconcileStaleWorktrees()

      expect(stopsReported()).toEqual([])
    })

    it('exempts a session this process is still provisioning', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('slow-build')], provisioning: ['slow-build'] })

      await reconcileStaleWorktrees()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    // A reaper whose read failed must reap nothing: an empty set would
    // condemn every running workspace at once, and nothing un-marks a death.
    it('stands down entirely until the server has published a set', async () => {
      mockWorkspaces.mockResolvedValue([])

      await reconcileStaleWorktrees()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    it('leaves a row alone while its pod is running', async () => {
      mockWorkspaces.mockResolvedValue([pod('healthy')])
      mockProbe.mockResolvedValue('alive' as TmuxLiveness)
      setDesired({ live: [row('healthy', true)] })

      await reconcileStaleWorktrees()
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })
  })
})
