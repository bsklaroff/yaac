import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as podsModule from '#drivers/k8s/substrate/pods'
import { runtimeHandleFromPod } from '#drivers/k8s/workspaces'
import type { RuntimeHandle, StrayUnit } from '#drivers/contract'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'

vi.mock('#drivers/k8s/substrate/pods', async (importOriginal) => {
  const actual = await importOriginal<typeof podsModule>()
  return { ...actual }
})

// The liveness probes are stubbed inputs; cleanupWorkspaceDetached is the
// destructive action the tests assert on.
vi.mock('#runtime/status/liveness', () => ({
  probeTmuxLiveness: vi.fn(),
  probeAgentPaneState: vi.fn(),
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
  // (docs/queued-workspaces.md).
  releaseQueuedChildren: vi.fn(),
}))

import { probeTmuxLiveness, probeAgentPaneState } from '#runtime/status/liveness'
import { cleanupWorkspaceDetached } from '#domain/workspaces/cleanup'
import { markWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { serverLog } from '#log'
import { applyWorkspaceEvent, desiredWorkspaces, releaseQueuedChildren } from '#db'
import { clearAllProvisioningForTests, registerProvisioning } from '#domain/workspaces/provisioning'
import type { WorkspaceEvent } from '#db'
import {
  reconcileStaleWorkspaces,
  _clearMissingPodTimersForTests,
} from '#domain/workspaces/stale-workspaces'

/** The workspaces the runtime reports for a pass. Stray units are set
 *  directly through `mockStrays`. */
const mockWorkspaces = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockStrays = vi.fn<() => Promise<StrayUnit[]>>()
const view = { resync: true, workspaces: mockWorkspaces, strayUnits: mockStrays }
const mockProbe = vi.mocked(probeTmuxLiveness)
const mockPaneProbe = vi.mocked(probeAgentPaneState)
const mockCleanup = vi.mocked(cleanupWorkspaceDetached)
const appliedEvents: WorkspaceEvent[] = []
const stopsReported = (): Array<[string, string, unknown]> => appliedEvents
  .filter((e) => e.type === 'workspace-stopped')
  .map((e) => [e.projectSlug, e.workspaceId, e.cause])
/** What the reaper's DB read returns, plus which creates are in flight
 *  (registered in the real provisioning registry). */
interface DesiredSetup {
  live: Array<{ projectSlug: string; workspaceId: string; ran: boolean }>
  stopped: string[]
  provisioning: string[]
}
let lastDesired: DesiredSetup = { live: [], stopped: [], provisioning: [] }
const setDesired = (d: Partial<DesiredSetup>): void => {
  lastDesired = { live: [], stopped: [], provisioning: [], ...d }
  clearAllProvisioningForTests()
  for (const workspaceId of lastDesired.provisioning) {
    registerProvisioning({ workspaceId, projectSlug: 'proj', tool: 'claude', kind: 'create' })
  }
  vi.mocked(desiredWorkspaces).mockResolvedValue({
    live: lastDesired.live, stopped: lastDesired.stopped,
  })
}
const mockLog = vi.mocked(serverLog)

// createdAtMs=1 (epoch) is always older than any grace window.
function pod(workspaceId: string, running = true): RuntimeHandle {
  return runtimeHandleFromPod({
    jobName: `yaac-proj-${workspaceId}`,
    podName: `yaac-proj-${workspaceId}-x1`,
    workspaceId,
    projectSlug: 'proj',
    projectId: '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
    tool: 'claude',
    phase: running ? 'Running' : 'Failed',
    running,
    terminating: false,
    createdAtMs: 1,
    labels: {},
  })
}

/** A runtime unit with no workspace behind it. */
function stray(workspaceId: string, createdAtMs = 1): StrayUnit {
  return { workspaceId, unitName: `yaac-proj-${workspaceId}`, projectSlug: 'proj', createdAtMs }
}

function loggedLines(): string {
  return mockLog.mock.calls.map(([m]) => m).join('\n')
}

describe('reconcileStaleWorkspaces', () => {
  beforeEach(() => {
    mockWorkspaces.mockReset().mockResolvedValue([])
    mockStrays.mockReset().mockResolvedValue([])
    installFakeWorkspaceDriver()
    mockProbe.mockReset()
    mockPaneProbe.mockReset().mockResolvedValue('started')
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

    await reconcileStaleWorkspaces(view)

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
    // Its queued workspaces stay queued until the user acts.
    expect(releaseQueuedChildren).not.toHaveBeenCalled()
  })

  // The driver derives the cause; the reaper must pass it to the teardown
  // and the audit log.
  it('reaps a stopped workspace with its derived death cause, and audits it', async () => {
    mockWorkspaces.mockResolvedValue([{
      ...pod('oomed-1', false),
      deathCause: { reason: 'oom', detail: 'exit code 137' },
    }])

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'oomed-1',
        cause: { reason: 'oom', detail: 'exit code 137' },
      }),
    )
    expect(loggedLines()).toContain('pod stopped: oom (exit code 137)')
  })

  it('keeps a not-yet-Running pod past grace while its create is still provisioning', async () => {
    // A pod still pulling its image or mounting hostPaths reads as
    // `pod-stopped`. Reaping it would delete the dir it is mounting.
    mockWorkspaces.mockResolvedValue([pod('starting-1', false)])
    setDesired({ provisioning: ['starting-1'] })

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a not-yet-Running pod once its create has failed', async () => {
    // A failed row lingers until dismissed, so it must not shield a session
    // the create already rolled back.
    mockWorkspaces.mockResolvedValue([pod('failed-1', false)])
    setDesired({ provisioning: [] })

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'failed-1', cause: { reason: 'pod-stopped' } }),
    )
  })

  it('keeps an orphan Job whose pod has not been admitted yet while its create is in flight', async () => {
    mockWorkspaces.mockResolvedValue([])
    mockStrays.mockResolvedValue([stray('pending-1')])
    setDesired({ provisioning: ['pending-1'] })

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive probe, and logs the near-miss', async () => {
    mockWorkspaces.mockResolvedValue([pod('blip-1')])
    mockProbe.mockResolvedValue('unknown')

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
    const log = loggedLines()
    expect(log).toContain('keeping session=blip-1')
    expect(log).toContain('inconclusive')
  })

  it('keeps a pod with a live tmux untouched and unlogged', async () => {
    mockWorkspaces.mockResolvedValue([pod('healthy-1')])
    mockProbe.mockResolvedValue('alive')

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(loggedLines()).toBe('')
  })

  it('reaps an out-of-band terminating pod past grace that we did not mark', async () => {
    // Terminating, not marked by us, and no stop row: an external delete
    // stuck past grace. Re-issue the teardown with the out-of-band cause.
    mockWorkspaces.mockResolvedValue([{ ...pod('term-1'), terminating: true }])

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'term-1',
        jobName: 'yaac-proj-term-1',
        cause: { reason: 'orphaned', detail: 'pod deleted out-of-band' },
      }),
    )
    expect(loggedLines()).toContain('terminating out-of-band past grace')
  })

  it('keeps a terminating pod past grace while its create is still provisioning', async () => {
    // A failed create deletes its Job before giving up; the reaper must not
    // race its teardown.
    mockWorkspaces.mockResolvedValue([{ ...pod('failing-1'), terminating: true }])
    setDesired({ provisioning: ['failing-1'] })

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // Every sweep needs the desired set; without it a user delete would be
  // labelled out-of-band and nothing would be exempt. Reaping on a guess
  // destroys uncommitted work, so the step fails and the next pass retries.
  it('fails without reaping when the desired set cannot be read', async () => {
    mockWorkspaces.mockResolvedValue([{ ...pod('term-unknown'), terminating: true }])
    vi.mocked(desiredWorkspaces).mockRejectedValue(new Error('db is gone'))

    await expect(reconcileStaleWorkspaces(view)).rejects.toThrow('db is gone')

    expect(mockCleanup).not.toHaveBeenCalled()
    expect(stopsReported()).toEqual([])
  })

  it('does NOT mislabel a yaac-deleted terminating pod whose mark was lost', async () => {
    // Same pod state as the out-of-band case (the in-memory mark was lost to
    // a restart or TTL), but the row's stoppedAt proves yaac issued the
    // delete. Resume teardown without restamping the cause.
    mockWorkspaces.mockResolvedValue([{ ...pod('term-ours'), terminating: true }])
    setDesired({ stopped: ['proj/term-ours'] })

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'term-ours',
        jobName: 'yaac-proj-term-ours',
        preserveDeletedRecord: true,
      }),
    )
    // No out-of-band cause is passed.
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup.mock.calls[0][0]).not.toHaveProperty('cause')
    const log = loggedLines()
    expect(log).toContain('resuming teardown session=term-ours')
    expect(log).not.toContain('out-of-band')
  })

  it('does NOT re-reap a terminating pod whose teardown we already issued', async () => {
    markWorkspaceTerminating('term-2')
    mockWorkspaces.mockResolvedValue([{ ...pod('term-2'), terminating: true }])

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a live-tmux pod whose agent pane is still the placeholder past grace', async () => {
    mockWorkspaces.mockResolvedValue([pod('half-1')])
    mockProbe.mockResolvedValue('alive')
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'half-1', jobName: 'yaac-proj-half-1' }),
    )
    const log = loggedLines()
    expect(log).toContain('reaping session=half-1')
    expect(log).toContain('agent never started')
  })

  it('keeps a placeholder pane past grace while its create is still provisioning', async () => {
    mockWorkspaces.mockResolvedValue([pod('warming-1')])
    mockProbe.mockResolvedValue('alive')
    mockPaneProbe.mockResolvedValue('placeholder')
    setDesired({ provisioning: ['warming-1'] })

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a placeholder pane while the pod is inside the grace window', async () => {
    const fresh = { ...pod('fresh-1'), createdAtMs: Date.now() }
    mockWorkspaces.mockResolvedValue([fresh])
    mockProbe.mockResolvedValue('alive')
    mockPaneProbe.mockResolvedValue('placeholder')

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('does NOT reap on an inconclusive agent-pane probe', async () => {
    mockWorkspaces.mockResolvedValue([pod('pane-blip-1')])
    mockProbe.mockResolvedValue('alive')
    mockPaneProbe.mockResolvedValue('unknown')

    await reconcileStaleWorkspaces(view)

    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps an orphan Job that has no backing pod, and labels the reason', async () => {
    mockWorkspaces.mockResolvedValue([])
    mockStrays.mockResolvedValue([stray('orphan-1')])

    await reconcileStaleWorkspaces(view)

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

    await expect(reconcileStaleWorkspaces(view)).rejects.toThrow('cluster offline')
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

    await expect(reconcileStaleWorkspaces(view)).resolves.toBeUndefined()

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'zombie-1' }),
    )
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(loggedLines()).not.toContain('orphan Job')
    expect(loggedLines()).toContain('skipping the orphan sweep')
  })

  describe('rows whose pod is missing', () => {
    const row = (workspaceId: string, ran = false) => ({
      projectSlug: 'proj',
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
      await reconcileStaleWorkspaces(view)
    }

    it('records nothing on the first tick a pod is missing', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorkspaces(view)

      expect(stopsReported()).toEqual([])
    })

    it('records an abandoned create once it has stayed podless for the window', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('abandoned')] })

      await reconcileStaleWorkspaces(view)
      await tickPastGrace()

      expect(stopsReported()).toEqual([
          ['proj', 'abandoned', { reason: 'never-started', detail: 'session create did not complete' }],
        ])
    })

    it('calls a session that ran orphaned, not never-started', async () => {
      // A captured prompt or transcript proves the agent started, so its Job
      // was deleted out-of-band.
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('had-history', true)] })

      await reconcileStaleWorkspaces(view)
      await tickPastGrace()

      expect(stopsReported()).toEqual([
          ['proj', 'had-history', { reason: 'orphaned', detail: 'Job and pod deleted out-of-band' }],
        ])
    })

    it('a single empty-but-successful pod listing condemns nothing', async () => {
      // An informer cache before its initial sync returns [] without
      // throwing, so every session looks podless for one tick. A recorded
      // death cannot be undone.
      setDesired({ live: [row('old-1', true), row('old-2', true)] })
      mockWorkspaces.mockResolvedValue([pod('old-1'), pod('old-2')])
      mockProbe.mockResolvedValue('alive')
      await reconcileStaleWorkspaces(view)

      mockWorkspaces.mockResolvedValue([]) // the bad listing
      await reconcileStaleWorkspaces(view)

      // The pods are back on the next tick, well within the window.
      mockWorkspaces.mockResolvedValue([pod('old-1'), pod('old-2')])
      vi.setSystemTime(Date.now() + 31 * 60_000)
      await reconcileStaleWorkspaces(view)

      expect(stopsReported()).toEqual([])
    })

    it('exempts a session this process is still provisioning', async () => {
      mockWorkspaces.mockResolvedValue([])
      setDesired({ live: [row('slow-build')], provisioning: ['slow-build'] })

      await reconcileStaleWorkspaces(view)
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    // Treating an unread set as empty would condemn every running workspace.
    it('stands down entirely until the server has published a set', async () => {
      mockWorkspaces.mockResolvedValue([])

      await reconcileStaleWorkspaces(view)
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })

    it('leaves a row alone while its pod is running', async () => {
      mockWorkspaces.mockResolvedValue([pod('healthy')])
      mockProbe.mockResolvedValue('alive')
      setDesired({ live: [row('healthy', true)] })

      await reconcileStaleWorkspaces(view)
      await tickPastGrace()

      expect(stopsReported()).toEqual([])
    })
  })
})
