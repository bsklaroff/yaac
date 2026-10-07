import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as dbModule from '#db'

vi.mock('#domain/workspaces/create', () => ({
  createWorkspace: vi.fn(),
  resolveCreate: vi.fn(),
}))
vi.mock('#domain/workspaces/spare-pool', () => ({
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#domain/workspaces/cleanup', () => ({
  // The awaited teardown. The reap removes the spare's checkout after it, so
  // it must not resolve before the Job is gone.
  cleanupWorkspace: vi.fn().mockResolvedValue(true),
  deleteWorkspaceState: vi.fn().mockResolvedValue(true),
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#domain/git', async (importOriginal) => ({
  ...await importOriginal<object>(),
  getDefaultBranch: vi.fn(),
  resolveRemoteRef: vi.fn(),
}))
vi.mock('#db', async (importOriginal) => ({
  ...(await importOriginal<typeof dbModule>()),
  getTimeZone: vi.fn(),
  getWorkspaceRow: vi.fn(),
  listProjectRows: vi.fn(),
}))

import { reconcilePrewarmPool } from '#domain/workspaces/prewarm-reconcile'
// Module state, used to set up mid-claim / mid-spawn cases and assert on.
import { claiming, inFlight, refreshing, clearPrewarmStateForTests } from '#domain/workspaces/prewarm'
import { rebranchSpare } from '#domain/workspaces/spare-pool'
import { getDefaultBranch, resolveRemoteRef } from '#domain/git'
import { LABEL_PREWARMED, type PodInfo } from '#drivers/k8s/substrate/pods'
import { runtimeHandleFromPod } from '#drivers/k8s/workspaces'
import type { RuntimeHandle } from '#drivers/contract'
import {
  installFakeWorkspaceDriver,
  snapshotFixture,
} from '@yaac/test-utils/fake-driver'
import { createWorkspace, resolveCreate, type CreateSetup } from '#domain/workspaces/create'
import { clearAllProvisioningForTests, failProvisioning, registerProvisioning } from '#domain/workspaces/provisioning'
import { cleanupWorkspace, deleteWorkspaceState } from '#domain/workspaces/cleanup'
import { getTimeZone, getWorkspaceRow, listProjectRows, type ProjectRow, type WorkspaceRow } from '#db'

/** The workspaces the runtime reports for a pass. */
const mockWorkspaces = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockCreate = vi.mocked(createWorkspace)
const mockCleanup = vi.mocked(cleanupWorkspace)
const mockDeleteState = vi.mocked(deleteWorkspaceState)
const mockResolveCreate = vi.mocked(resolveCreate)

/** The project's default create setup, which a spare is warmed with. */
const SETUP: CreateSetup = { tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'bypass', mode: 'tui' }
const WARM = { ...SETUP, prewarm: true, workspaceId: expect.any(String) as string }

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Run one reconcile pass, then wait for its spawns to reach
 *  `createWorkspace`. */
async function pass(): Promise<void> {
  await reconcilePrewarmPool({ ...snapshotFixture(), workspaces: mockWorkspaces })
  await flush()
}

function pod(o: Partial<PodInfo> & { prewarmed?: boolean } = {}): RuntimeHandle {
  const { prewarmed, ...rest } = o
  return runtimeHandleFromPod({
    jobName: 'yaac-p-s1',
    podName: 'yaac-p-s1-x',
    workspaceId: 's1',
    projectId: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_000,
    labels: prewarmed ? { [LABEL_PREWARMED]: 'true' } : {},
    ...rest,
  })
}

describe('reconcilePrewarmPool', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    clearAllProvisioningForTests()
    mockWorkspaces.mockResolvedValue([])
    installFakeWorkspaceDriver()
    mockResolveCreate.mockResolvedValue(SETUP)
    vi.mocked(listProjectRows).mockResolvedValue([])
    vi.mocked(getTimeZone).mockResolvedValue({ timeZone: null, pinned: false })
    vi.mocked(getWorkspaceRow).mockResolvedValue(undefined)
    mockCreate.mockResolvedValue({ workspaceId: 's', jobName: 'yaac-p-s', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
    // Default to success: each reap step waits on the previous one, so a
    // falsy default would silently skip the deletions under test.
    mockCleanup.mockResolvedValue(true)
    mockDeleteState.mockResolvedValue(true)
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('spawns a prewarmed spare for an active project', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass()
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('reaps a spare for an idle project', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true })])
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectId: 'p', workspaceId: 's2' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('removes the reaped spare\'s workspace state only once its pod is gone', async () => {
    // The checkout must go only after the awaited teardown. The detached
    // teardown resolves before the Job delete starts, so using it would pull
    // /workspace out from under a live pod, and a crash then would leave a
    // claimable spare with no checkout.
    const order: string[] = []
    let releaseTeardown = (): void => { /* replaced below */ }
    mockCleanup.mockImplementation(async () => {
      order.push('teardown-started')
      await new Promise<void>((r) => { releaseTeardown = r })
      order.push('teardown-done')
      return true
    })
    mockDeleteState.mockImplementation(() => { order.push('state-deleted'); return Promise.resolve(true) })
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true })])

    await pass()
    await flush()
    // The tick does not wait on the teardown, and nothing is deleted yet.
    expect(order).toEqual(['teardown-started'])

    releaseTeardown()
    await flush()
    expect(order).toEqual(['teardown-started', 'teardown-done', 'state-deleted'])
    expect(mockDeleteState).toHaveBeenCalledWith('p', 's2')
  })

  it('keeps the checkout when the teardown could not confirm the pod is gone', async () => {
    // A timed-out Job delete leaves a pod still writing to /workspace. The
    // spare keeps its row so the startup sweep can retry.
    mockCleanup.mockResolvedValue(false)
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's3', prewarmed: true })])

    await pass()
    await flush()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockDeleteState).not.toHaveBeenCalled()
  })

  // The pod stays listed while its teardown runs. Reaping it again would
  // exec into the dying pod and race the first reap's checkout removal.
  it('reaps a spare once while its teardown runs, and retries one left behind', async () => {
    let finishTeardown = (_gone: boolean): void => { /* replaced below */ }
    mockCleanup.mockImplementation(() => new Promise((r) => { finishTeardown = r }))
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true })])

    await pass()
    await pass()
    expect(mockCleanup).toHaveBeenCalledTimes(1)

    finishTeardown(false)
    await flush()
    await pass()
    expect(mockCleanup).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when the pool size is 0', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
    await pass()
    expect(mockWorkspaces).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('does not double-spawn across ticks while a spawn is in flight', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    mockCreate.mockReturnValue(new Promise<never>(() => { /* never resolves */ }))
    await pass()
    await pass()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('clears the in-flight counter when a spawn throws', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    mockCreate.mockRejectedValue(new Error('boom'))
    await pass()
    await flush()
    expect(inFlight.size).toBe(0)
  })

  it('does nothing for an empty cluster', async () => {
    mockWorkspaces.mockResolvedValue([])
    await pass()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('fails the step without acting when listing pods throws', async () => {
    mockWorkspaces.mockRejectedValue(new Error('cluster down'))
    await expect(pass()).rejects.toThrow('cluster down')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('is a no-op once the project already has its spare', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    await pass()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('refills behind a spare that is mid-claim, and never reaps it', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    claiming.add('yaac-p-spare')
    await pass()
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('counts a still-pending spare toward the pool (no over-spawn)', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true, running: false, phase: 'Pending' }),
    ])
    await pass()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('keeps a wrong-tool spare in the pool (retooled at claim time)', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-codex', workspaceId: 's2', tool: 'codex', prewarmed: true }),
    ])
    await pass()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('fills the pool to the configured size', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass()
    expect(mockCreate.mock.calls).toEqual([
      ['p', WARM],
      ['p', WARM],
    ])
  })

  it('reaps the oldest excess spare after the pool size is lowered', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-old', workspaceId: 'old', prewarmed: true, createdAtMs: 1_000 }),
      pod({ jobName: 'yaac-p-new', workspaceId: 'new', prewarmed: true, createdAtMs: 9_000 }),
    ])
    await pass()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-old', projectId: 'p', workspaceId: 'old' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('handles multiple projects independently, ignoring pods with no project', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-a-real', workspaceId: 'a1', projectId: 'a' }),
      pod({ jobName: 'yaac-a-spare', workspaceId: 'a2', projectId: 'a', prewarmed: true }),
      pod({ jobName: 'yaac-b-real', workspaceId: 'b1', projectId: 'b' }),
      pod({ jobName: 'orphan', workspaceId: 'o1', projectId: '' }),
    ])
    await pass()
    expect(mockCreate.mock.calls).toEqual([['b', WARM]])
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('warms a spare as the project\'s untouched create, remembered mode included', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass()
    expect(mockResolveCreate).toHaveBeenCalledWith('p', {})
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
  })

  // A claim cannot switch a spare's mode (the pod spec differs), so a spare
  // in an unused mode would never be taken. Other mismatches are fixed by a
  // respawn at claim time.
  it('replaces a spare warmed in another agent mode than the project now uses', async () => {
    vi.mocked(listProjectRows).mockResolvedValue([
      { id: 'p', lastTool: 'codex', createDefaults: { codex: { mode: 'acp' } } } as unknown as ProjectRow,
    ])
    vi.mocked(getWorkspaceRow).mockResolvedValue({ mode: 'tui' } as WorkspaceRow)
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectId: 'p', workspaceId: 's2' })
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
  })

  // `TZ` is fixed at launch too, so a spare warmed before the user's zone
  // changed (or was first reported) is replaced rather than left unclaimable.
  it('replaces a spare warmed in another zone than the user\'s current one', async () => {
    vi.mocked(listProjectRows).mockResolvedValue([
      { id: 'p', createDefaults: {} } as unknown as ProjectRow,
    ])
    vi.mocked(getTimeZone).mockResolvedValue({ timeZone: 'Asia/Tokyo', pinned: false })
    vi.mocked(getWorkspaceRow).mockResolvedValue({ mode: 'tui' } as WorkspaceRow)
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectId: 'p', workspaceId: 's2' })
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
  })

  it('keeps a spare whose mode matches, or whose row cannot be read', async () => {
    vi.mocked(listProjectRows).mockResolvedValue([
      { id: 'p', createDefaults: {} } as unknown as ProjectRow,
    ])
    vi.mocked(getWorkspaceRow).mockResolvedValue({ mode: 'acp' } as WorkspaceRow)
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    await pass()
    vi.mocked(getWorkspaceRow).mockRejectedValue(new Error('db hiccup'))
    await pass()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('drops each spawn from the in-flight set as it settles', async () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    let settleFirst = (): void => { /* replaced below */ }
    mockCreate
      .mockReturnValueOnce(new Promise((resolve) => {
        settleFirst = () => resolve({ workspaceId: 's', jobName: 'yaac-p-s', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
      }))
      .mockReturnValue(new Promise<never>(() => { /* never resolves */ }))

    await pass()
    expect([...inFlight.values()]).toEqual(['p', 'p'])

    settleFirst()
    await flush()
    // The unsettled spawn stays, so the next tick does not start another.
    expect([...inFlight.values()]).toEqual(['p'])
  })

  // A spawn's pod is listed well before its create settles. Reaping it then
  // would make the create retry into the same fate.
  it('never reaps a spare whose spawn is still in flight, nor counts it twice', async () => {
    mockCreate.mockReturnValue(new Promise<never>(() => { /* never resolves */ }))
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass()
    const [[, { workspaceId }]] = mockCreate.mock.calls as unknown as [[string, { workspaceId: string }]]
    const warming = pod({ jobName: `yaac-p-${workspaceId}`, workspaceId, prewarmed: true, running: false })

    // One spare beside the real workspace, so no refill.
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }), warming])
    await pass()
    // The project is now idle, but the spare is not drained until its spawn
    // settles.
    mockWorkspaces.mockResolvedValue([warming])
    await pass()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCleanup).not.toHaveBeenCalled()

    inFlight.clear()
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: `yaac-p-${workspaceId}`, projectId: 'p', workspaceId })
  })

  // A restart takes its pod down before the new one runs. The project is not
  // idle during that gap, so its spare stays. A failed restart does not count.
  it('keeps an idle project\'s spare while one of its workspaces is restarting', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1', running: false, terminating: true }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    registerProvisioning({ workspaceId: 'r1', projectId: 'p', tool: 'claude', kind: 'restart' })
    await pass()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()

    failProvisioning('r1', 'boom')
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectId: 'p', workspaceId: 's2' })
  })

  describe('keeping spares on their base branch\'s tip', () => {
    /** The spare's checkout HEAD, as an exec into it reads it. */
    let head: string
    const mockRebranch = vi.mocked(rebranchSpare)
    const exec = vi.fn(() => Promise.resolve({ stdout: `${head}\n`, stderr: '' }))
    const active = (): RuntimeHandle[] => [
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ]

    beforeEach(() => {
      head = 'old'
      exec.mockClear()
      installFakeWorkspaceDriver({ exec })
      vi.mocked(getWorkspaceRow).mockResolvedValue({
        projectId: 'p', workspaceId: 's2', baseBranch: 'dev', permissionMode: 'plan', mode: 'tui', model: 'claude-opus-5-5',
      } as WorkspaceRow)
      vi.mocked(getDefaultBranch).mockResolvedValue('main')
      vi.mocked(resolveRemoteRef).mockResolvedValue('new')
      mockRebranch.mockResolvedValue(undefined)
      mockWorkspaces.mockResolvedValue(active())
    })

    // So a claim finds it current instead of resetting it, rerunning the
    // init windows and restarting the agent while the user waits.
    it('moves a spare to its base\'s new tip in the background, as warmed, once per tip', async () => {
      await pass()
      await flush()
      expect(mockRebranch).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 's2' }), 'dev', 'new',
        { tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan', mode: 'tui' },
      )
      // Already at that tip: no further exec, let alone a move.
      head = 'new'
      await pass()
      await flush()
      expect(exec).toHaveBeenCalledTimes(1)
      expect(mockRebranch).toHaveBeenCalledTimes(1)

      // A spare already at the tip is only read.
      clearPrewarmStateForTests()
      await pass()
      await flush()
      expect(exec).toHaveBeenCalledTimes(2)
      expect(mockRebranch).toHaveBeenCalledTimes(1)
    })

    it('keeps a spare mid-refresh in the pool without reaping it, and reaps one a refresh broke', async () => {
      let finish = (): void => {}
      mockRebranch.mockReturnValue(new Promise((resolve) => { finish = resolve }))
      await pass()
      await flush()
      expect(refreshing.has('yaac-p-spare')).toBe(true)
      // The project went idle, which would reap its spare.
      mockWorkspaces.mockResolvedValue(active().slice(1))
      await pass()
      expect(mockCleanup).not.toHaveBeenCalled()
      expect(mockCreate).not.toHaveBeenCalled()
      finish()
      await flush()
      expect(refreshing.size).toBe(0)

      clearPrewarmStateForTests()
      mockWorkspaces.mockResolvedValue(active())
      mockRebranch.mockRejectedValue(new Error('reset failed'))
      await pass()
      await flush()
      expect(mockCleanup).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare', workspaceId: 's2' }))
    })
  })

  it('swallows a failed reap — the stale-session reaper retries', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true })])
    mockCleanup.mockRejectedValue(new Error('pod gone'))
    await expect(pass()).resolves.toBeUndefined()
    await flush()
  })
})
