import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RuntimeHandle, StrayUnit } from '#drivers/contract'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'

// The liveness probes are stubbed inputs; cleanupWorkspaceDetached is the
// destructive action the tests assert on, run for real where a case says so.
vi.mock('#runtime/status/liveness', () => ({
  probeTmuxLiveness: vi.fn(),
  probeSetupState: vi.fn(),
  forgetLiveness: vi.fn(),
}))
vi.mock('#domain/workspaces/cleanup', () => ({
  cleanupWorkspaceDetached: vi.fn().mockResolvedValue(undefined),
}))


// The reaper reads the desired set from the DB and reports deaths as
// events. Both are stubbed, so no DB is opened.
vi.mock('#db', () => ({
  applyWorkspaceEvent: vi.fn(),
  desiredWorkspaces: vi.fn(),
  // After a death, queued children wait instead of starting
  // (docs/queued-workspaces.md), while what waits for room in a group is
  // looked for (docs/workspace-groups.md).
  releaseQueuedChildren: vi.fn(),
  listQueuedWorkspaceRows: vi.fn().mockResolvedValue([]),
}))

import { forgetLiveness, probeTmuxLiveness, probeSetupState } from '#runtime/status/liveness'
import { cleanupWorkspaceDetached } from '#domain/workspaces/cleanup'
import type * as CleanupModule from '#domain/workspaces/cleanup'
import { markWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { serverLog } from '#lib/log'
import { testEnv } from '@yaac/shared/env'
import { applyWorkspaceEvent, desiredWorkspaces, listQueuedWorkspaceRows, releaseQueuedChildren } from '#db'
import {
  claimProvisioning, clearAllProvisioningForTests, failProvisioning, registerProvisioning, removeProvisioning,
} from '#domain/workspaces/provisioning'
import type { WorkspaceEvent } from '#db'
import {
  reconcileStaleWorkspaces,
  _clearMissingPodTimersForTests,
} from '#domain/workspaces/stale-workspaces'

/** The workspaces the runtime reports for a pass. Stray units are set
 *  directly through `mockStrays`. */
const mockWorkspaces = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockStrays = vi.fn<() => Promise<StrayUnit[]>>()
const view = { resync: true, takenAtMs: 0, workspaces: mockWorkspaces, strayUnits: mockStrays }
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockSetupProbe = vi.mocked(probeSetupState)
const mockCleanup = vi.mocked(cleanupWorkspaceDetached)
const appliedEvents: WorkspaceEvent[] = []
const stopsReported = (): Array<[string, string, unknown]> => appliedEvents
  .filter((e) => e.type === 'workspace-stopped')
  .map((e) => [e.projectId, e.workspaceId, e.cause])
/** What the reaper's DB read returns, plus which creates are in flight
 *  (registered in the real provisioning registry). */
interface DesiredSetup {
  live: Array<{ projectId: string; workspaceId: string; ran: boolean; restartedFrom?: Date }>
  provisioning: string[]
}
let lastDesired: DesiredSetup = { live: [], provisioning: [] }
const setDesired = (d: Partial<DesiredSetup>): void => {
  lastDesired = { live: [], provisioning: [], ...d }
  clearAllProvisioningForTests()
  for (const workspaceId of lastDesired.provisioning) {
    registerProvisioning({ workspaceId, projectId: 'proj', tool: 'claude', kind: 'create' })
  }
  vi.mocked(desiredWorkspaces).mockResolvedValue({ live: lastDesired.live })
}
const mockLog = vi.mocked(serverLog)

// createdAtMs=1 (epoch) is always older than any grace window.
function pod(workspaceId: string, running = true): RuntimeHandle {
  return handleFixture({
    jobName: `yaac-proj-${workspaceId}`,
    workspaceId,
    projectId: 'proj',
    running,
    state: running ? 'running' : 'failed',
    createdAtMs: 1,
  })
}

/** A runtime unit with no workspace behind it. */
function stray(workspaceId: string, createdAtMs = 1): StrayUnit {
  return { workspaceId, unitName: `yaac-proj-${workspaceId}`, projectId: 'proj', createdAtMs }
}

function loggedLines(): string {
  return mockLog.mock.calls.map(([m]) => m).join('\n')
}

describe('reconcileStaleWorkspaces', () => {
  const wakeAt = vi.fn<(atMs: number) => void>()

  beforeEach(() => {
    wakeAt.mockReset()
    mockWorkspaces.mockReset().mockResolvedValue([])
    mockStrays.mockReset().mockResolvedValue([])
    installFakeWorkspaceDriver()
    mockProbe.mockReset()
    mockSetupProbe.mockReset().mockResolvedValue('done')
    mockCleanup.mockClear()
    appliedEvents.length = 0
    vi.mocked(applyWorkspaceEvent).mockImplementation((event) => {
      appliedEvents.push(event)
      return Promise.resolve()
    })
    setDesired({})
    mockLog.mockClear()
    _clearTerminatingForTests()
  })

  it('reaps a running pod whose tmux is conclusively dead, and audits it', async () => {
    mockWorkspaces.mockResolvedValue([pod('zombie-1')])
    mockProbe.mockResolvedValue('dead')

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'zombie-1',
        jobName: 'yaac-proj-zombie-1',
        cause: { reason: 'agent-exited' },
      }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=zombie-1')
    expect(log).toContain('tmux gone')
    // Its queued workspaces stay queued until the user acts, but its slot
    // in its group is offered to what waits for room.
    expect(releaseQueuedChildren).not.toHaveBeenCalled()
    expect(listQueuedWorkspaceRows).toHaveBeenCalled()
  })

  it('looks for what waits for room on every pass, since a runtime going away frees a slot', async () => {
    vi.mocked(listQueuedWorkspaceRows).mockClear()
    mockWorkspaces.mockResolvedValue([pod('alive')])
    mockProbe.mockResolvedValue('alive')
    await reconcileStaleWorkspaces(view, wakeAt)
    expect(listQueuedWorkspaceRows).toHaveBeenCalled()
  })

  // The driver derives the cause; the reaper must pass it to the teardown,
  // which records it with the stop and audits it.
  it('reaps a stopped workspace with its derived death cause, and audits it', async () => {
    const actual = await vi.importActual<typeof CleanupModule>('#domain/workspaces/cleanup')
    mockCleanup.mockImplementationOnce(actual.cleanupWorkspaceDetached)
    mockWorkspaces.mockResolvedValue([{
      ...pod('oomed-1', false),
      deathCause: { reason: 'oom', detail: 'exit code 137' },
    }])

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'oomed-1',
        cause: { reason: 'oom', detail: 'exit code 137' },
      }),
    )
    expect(stopsReported()).toEqual([['proj', 'oomed-1', { reason: 'oom', detail: 'exit code 137' }]])
    expect(loggedLines()).toContain('pod stopped: oom (exit code 137)')
    expect(loggedLines()).toContain('reported cause=oom (exit code 137), kept only if no stop is recorded yet')
  })

  it('keeps a not-yet-Running pod past grace while its create is still provisioning', async () => {
    // A pod still pulling its image or mounting hostPaths reads as
    // `pod-stopped`. Reaping it would delete the dir it is mounting.
    mockWorkspaces.mockResolvedValue([pod('starting-1', false)])
    setDesired({ provisioning: ['starting-1'] })

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // A create that took a spare runs under the spare's id, not its own. Once
  // launched it is reaped like any workspace, so a dead one would be torn
  // down here while the create's own failure path tears it down too.
  it('keeps a dead workspace in a spare a create took until the create settles', async () => {
    mockWorkspaces.mockResolvedValue([pod('claimed-1')])
    mockProbe.mockResolvedValue('dead')
    setDesired({ provisioning: ['req-1'] })
    claimProvisioning('req-1', 'claimed-1')

    await reconcileStaleWorkspaces(view, wakeAt)
    expect(mockCleanup).not.toHaveBeenCalled()

    // A create that failed has rolled back, and shields nothing.
    failProvisioning('req-1', 'boom')
    await reconcileStaleWorkspaces(view, wakeAt)
    expect(mockCleanup).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'claimed-1' }))
  })

  // A spare's pod is older than the startup grace, so a `dead` cached
  // before its session opened would reap the new workspace once its create
  // no longer shields it.
  it('has a settled create forget what was probed of the spare it took', () => {
    setDesired({ provisioning: ['req-1'] })
    claimProvisioning('req-1', 'claimed-1')
    vi.mocked(forgetLiveness).mockClear()
    removeProvisioning('req-1')
    expect(vi.mocked(forgetLiveness).mock.calls).toEqual([['proj', 'req-1'], ['proj', 'claimed-1']])
  })

  it('reaps a not-yet-Running pod once its create has failed', async () => {
    // A failed row lingers until dismissed, so it must not shield a session
    // the create already rolled back.
    mockWorkspaces.mockResolvedValue([pod('failed-1', false)])
    setDesired({ provisioning: [] })

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'failed-1', cause: { reason: 'pod-stopped' } }),
    )
  })

  it('keeps an orphan Job whose pod has not been admitted yet while its create is in flight', async () => {
    mockWorkspaces.mockResolvedValue([])
    mockStrays.mockResolvedValue([stray('pending-1')])
    setDesired({ provisioning: ['pending-1'] })

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive probe, and logs the near-miss', async () => {
    mockWorkspaces.mockResolvedValue([pod('blip-1')])
    mockProbe.mockResolvedValue('unknown')

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
    const log = loggedLines()
    expect(log).toContain('keeping session=blip-1')
    expect(log).toContain('inconclusive')
  })

  it('keeps a pod with a live tmux untouched and unlogged', async () => {
    mockWorkspaces.mockResolvedValue([pod('healthy-1')])
    mockProbe.mockResolvedValue('alive')

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(loggedLines()).toBe('')
  })

  it('reaps a terminating pod past grace that we did not mark', async () => {
    // Terminating and not marked by us: an external delete, or ours with
    // the mark lost, stuck past grace. Re-issue the teardown with the
    // out-of-band cause, which the row keeps only if nothing stopped it.
    mockWorkspaces.mockResolvedValue([{ ...pod('term-1'), terminating: true }])

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'term-1',
        jobName: 'yaac-proj-term-1',
        cause: { reason: 'orphaned', detail: 'pod deleted out-of-band' },
      }),
    )
    expect(loggedLines()).toContain('terminating past grace: out-of-band delete')
  })

  it('keeps a terminating pod past grace while its create is still provisioning', async () => {
    // A failed create deletes its Job before giving up; the reaper must not
    // race its teardown.
    mockWorkspaces.mockResolvedValue([{ ...pod('failing-1'), terminating: true }])
    setDesired({ provisioning: ['failing-1'] })

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // A pass reads the desired set before reaping anything. Reaping on a
  // guess destroys uncommitted work, so the step fails and the next pass
  // retries.
  it('fails without reaping when the desired set cannot be read', async () => {
    mockWorkspaces.mockResolvedValue([{ ...pod('term-unknown'), terminating: true }])
    vi.mocked(desiredWorkspaces).mockRejectedValue(new Error('db is gone'))

    await expect(reconcileStaleWorkspaces(view, wakeAt)).rejects.toThrow('db is gone')

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(stopsReported()).toEqual([])
  })

  it('does NOT re-reap a terminating pod whose teardown we already issued', async () => {
    markWorkspaceTerminating('term-2')
    mockWorkspaces.mockResolvedValue([{ ...pod('term-2'), terminating: true }])

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a live-tmux pod whose setup never finished, past grace', async () => {
    mockWorkspaces.mockResolvedValue([pod('half-1')])
    mockProbe.mockResolvedValue('alive')
    mockSetupProbe.mockResolvedValue('starting')

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'half-1', jobName: 'yaac-proj-half-1' }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=half-1')
    expect(log).toContain('setup never finished')
  })

  it('keeps an unfinished setup past grace while its create is still provisioning', async () => {
    mockWorkspaces.mockResolvedValue([pod('warming-1')])
    mockProbe.mockResolvedValue('alive')
    mockSetupProbe.mockResolvedValue('starting')
    setDesired({ provisioning: ['warming-1'] })

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps an unfinished setup while the pod is inside the grace window', async () => {
    const fresh = { ...pod('fresh-1'), createdAtMs: Date.now() }
    mockWorkspaces.mockResolvedValue([fresh])
    mockProbe.mockResolvedValue('alive')
    mockSetupProbe.mockResolvedValue('starting')

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a pod that stopped inside its grace window, asking to run again the moment it leaves it', async () => {
    // A sandbox killed seconds after it started: no event follows, so only
    // the wake gets it reaped before the next resync.
    const young = { ...pod('young-1', false), createdAtMs: Date.now() - 10_000 }
    const younger = { ...pod('younger-1', false), createdAtMs: Date.now() - 5_000 }
    mockWorkspaces.mockResolvedValue([younger, young, pod('old-1', false)])

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup.mock.calls.map(([t]) => (t as { workspaceId: string }).workspaceId)).toEqual(['old-1'])
    expect(wakeAt.mock.calls).toEqual([[young.createdAtMs + testEnv.startingGraceMs]])
  })

  it('does NOT reap on an inconclusive setup probe', async () => {
    mockWorkspaces.mockResolvedValue([pod('pane-blip-1')])
    mockProbe.mockResolvedValue('alive')
    mockSetupProbe.mockResolvedValue('unknown')

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps an orphan Job that has no backing pod, and labels the reason', async () => {
    mockWorkspaces.mockResolvedValue([])
    mockStrays.mockResolvedValue([stray('orphan-1')])

    await reconcileStaleWorkspaces(view, wakeAt)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'orphan-1',
        jobName: 'yaac-proj-orphan-1',
        cause: { reason: 'orphaned' },
      }),
    )
    expect(loggedLines()).toContain('orphan Job')
  })

  it('fails without reaping when pod listing fails', async () => {
    mockWorkspaces.mockRejectedValue(new Error('cluster offline'))

    await expect(reconcileStaleWorkspaces(view, wakeAt)).rejects.toThrow('cluster offline')
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // A failed workspace read stops every sweep, but a failed stray-unit read
  // only stops the orphan sweep: the workspaces that were read are still
  // conclusive. Merging the two reads (e.g. one Promise.all) would silently
  // make this a total stand-down.
  it('stands only the orphan sweep down when the stray-unit read fails', async () => {
    mockWorkspaces.mockResolvedValue([pod('zombie-1')])
    mockStrays.mockRejectedValue(new Error('informer down'))
    mockProbe.mockResolvedValue('dead')

    await expect(reconcileStaleWorkspaces(view, wakeAt)).resolves.toBeUndefined()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'zombie-1' }),
    )
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(loggedLines()).not.toContain('orphan Job')
    expect(loggedLines()).toContain('skipping the orphan sweep')
  })

  describe('rows whose pod is missing', () => {
    const row = (workspaceId: string, ran = false) => ({
      projectId: 'proj',
      workspaceId,
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
      await reconcileStaleWorkspaces(view, wakeAt)
    }

    it('records nothing on the first tick a pod is missing', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorkspaces(view, wakeAt)

      expect(stopsReported()).toEqual([])
    })

    it('records an abandoned create once it has stayed podless for the window', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()

      expect(stopsReported()).toEqual([
          ['proj', 'abandoned', { reason: 'never-started', detail: 'workspace create did not complete' }],
        ])
    })

    it('calls a session that ran orphaned, not never-started', async () => {
      // A captured prompt or transcript proves the agent started, so its Job
      // was deleted out-of-band.
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('had-history', true)] })

      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()

      expect(stopsReported()).toEqual([
          ['proj', 'had-history', { reason: 'orphaned', detail: 'Job and pod deleted out-of-band' }],
        ])
    })

    // The server died while restarting it, so nothing rolled the restart
    // back: its next life never came up. It goes on the second podless
    // pass, with no wait and no death, and the workspace reads as stopped
    // as it was.
    it('forgets the life an interrupted restart started, recording no death', async () => {
      const lifeBefore = new Date('2026-11-01T00:00:00Z')
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [{ ...row('restarting', true), restartedFrom: lifeBefore }] })

      await reconcileStaleWorkspaces(view, wakeAt)
      expect(appliedEvents).toEqual([])
      await reconcileStaleWorkspaces(view, wakeAt)

      expect(appliedEvents).toEqual([
        { type: 'workspace-create-failed', projectId: 'proj', workspaceId: 'restarting', lifeBefore },
      ])
      // A restart this process is running is left to it.
      appliedEvents.length = 0
      setDesired({ live: [{ ...row('restarting', true), restartedFrom: lifeBefore }], provisioning: ['restarting'] })
      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()
      expect(appliedEvents).toEqual([])
    })

    // The server died after its runtime was up and before saying so (under
    // k8s the pod outlives a server that is rolled). Found running, the
    // life is recorded as up, so losing its runtime later is a death.
    it('records an interrupted restart found running as launched, and keeps its life', async () => {
      mockWorkspaces.mockResolvedValue([pod('came-up')])
      mockProbe.mockResolvedValue('alive')
      const unlaunched = { ...row('came-up', true), restartedFrom: new Date('2026-11-01T00:00:00Z') }
      setDesired({ live: [unlaunched], provisioning: ['came-up'] })
      await reconcileStaleWorkspaces(view, wakeAt)
      expect(appliedEvents).toEqual([])

      setDesired({ live: [unlaunched] })
      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()
      expect(appliedEvents.map((e) => e.type)).toEqual(['workspace-launched', 'workspace-launched'])
    })

    it('a single empty-but-successful pod listing condemns nothing', async () => {
      // An informer cache before its initial sync returns [] without
      // throwing, so every session looks podless for one tick. A recorded
      // death cannot be undone.
      setDesired({ live: [row('old-1', true), row('old-2', true)] })
      mockWorkspaces.mockResolvedValue([pod('old-1'), pod('old-2')])
      mockProbe.mockResolvedValue('alive')
      await reconcileStaleWorkspaces(view, wakeAt)

      mockWorkspaces.mockResolvedValue([]) // the bad listing
      await reconcileStaleWorkspaces(view, wakeAt)

      // The pods are back on the next tick, well within the window.
      mockWorkspaces.mockResolvedValue([pod('old-1'), pod('old-2')])
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await reconcileStaleWorkspaces(view, wakeAt)

      expect(stopsReported()).toEqual([])
    })

    it('exempts a session this process is still provisioning', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('slow-build')], provisioning: ['slow-build'] })

      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    // Treating an unread set as empty would condemn every running workspace.
    it('stands down entirely until the server has published a set', async () => {
      mockWorkspaces.mockResolvedValue([])

      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    it('leaves a row alone while its pod is running', async () => {
      mockWorkspaces.mockResolvedValue([pod('healthy')])
      mockProbe.mockResolvedValue('alive')
      setDesired({ live: [row('healthy', true)] })

      await reconcileStaleWorkspaces(view, wakeAt)
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })
  })
})
