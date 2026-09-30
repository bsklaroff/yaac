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
  // The AWAITED teardown: the reap removes the spare's checkout off the back
  // of it, so it must not resolve before the Job is actually gone.
  cleanupWorkspace: vi.fn().mockResolvedValue(true),
  deleteWorkspaceState: vi.fn().mockResolvedValue(true),
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#db', async (importOriginal) => ({
  ...(await importOriginal<typeof dbModule>()),
  getWorkspaceRow: vi.fn(),
  listProjectRows: vi.fn(),
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { reconcilePrewarmPool } from '#domain/workspaces/prewarm-reconcile'
// `claiming` and `inFlight` are the module's shared state, read here to set
// up a mid-claim / mid-spawn cluster and asserted on afterwards.
import { claiming, inFlight, clearPrewarmStateForTests } from '#domain/workspaces/prewarm'
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
import { getWorkspaceRow, listProjectRows, type ProjectRow, type WorkspaceRow } from '#db'

/** What the registered runtime reports for the pass. */
const mockWorkspaces = vi.fn<() => Promise<RuntimeHandle[]>>()
const mockCreate = vi.mocked(createWorkspace)
const mockCleanup = vi.mocked(cleanupWorkspace)
const mockDeleteState = vi.mocked(deleteWorkspaceState)
const mockResolveCreate = vi.mocked(resolveCreate)

/** What the project's untouched create resolves to — what a spare is warmed as. */
const SETUP: CreateSetup = { tool: 'claude', model: 'claude-opus-5-5', permissionMode: 'bypass', mode: 'tui' }
const WARM = { ...SETUP, prewarm: true, workspaceId: expect.any(String) as string }

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** One reconcile pass, then long enough for the spawns it fired — which
 *  resolve what to warm before creating — to reach `createWorkspace`. */
async function pass(snapshot?: Parameters<typeof reconcilePrewarmPool>[0]): Promise<void> {
  await reconcilePrewarmPool(snapshot)
  await flush()
}

function pod(o: Partial<PodInfo> & { prewarmed?: boolean } = {}): RuntimeHandle {
  const { prewarmed, ...rest } = o
  return runtimeHandleFromPod({
    jobName: 'yaac-p-s1',
    podName: 'yaac-p-s1-x',
    workspaceId: 's1',
    projectSlug: 'p',
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
    installFakeWorkspaceDriver({
      snapshot: () => ({ resync: true, workspaces: mockWorkspaces, strayUnits: () => Promise.resolve([]) }),
    })
    mockResolveCreate.mockResolvedValue(SETUP)
    vi.mocked(listProjectRows).mockResolvedValue([])
    vi.mocked(getWorkspaceRow).mockResolvedValue(undefined)
    mockCreate.mockResolvedValue({ workspaceId: 's', jobName: 'yaac-p-s', forwardedPorts: [], tool: 'claude', mode: 'tui' as const })
    // Both report success by default: the reap chain gates each step on the
    // one before it, so a falsy default would silently skip the deletions
    // every case here is about.
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
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectSlug: 'p', workspaceId: 's2' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('removes the reaped spare\'s workspace state only once its pod is gone', async () => {
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
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true })])

    await pass()
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
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's3', prewarmed: true })])

    await pass()
    await flush()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    expect(mockDeleteState).not.toHaveBeenCalled()
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

  it("reads workspaces from the pass view when one is provided, not the runtime's own", async () => {
    const workspaces = vi.fn().mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass({ ...snapshotFixture(), workspaces })
    expect(mockWorkspaces).not.toHaveBeenCalled()
    expect(workspaces).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
  })

  it('does nothing for an empty cluster', async () => {
    mockWorkspaces.mockResolvedValue([])
    await pass()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('skips the tick when listing pods throws', async () => {
    mockWorkspaces.mockRejectedValue(new Error('cluster down'))
    await pass()
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
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-old', projectSlug: 'p', workspaceId: 'old' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('handles multiple projects independently, ignoring pods with no project', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-a-real', workspaceId: 'a1', projectSlug: 'a' }),
      pod({ jobName: 'yaac-a-spare', workspaceId: 'a2', projectSlug: 'a', prewarmed: true }),
      pod({ jobName: 'yaac-b-real', workspaceId: 'b1', projectSlug: 'b' }),
      pod({ jobName: 'orphan', workspaceId: 'o1', projectSlug: '' }),
    ])
    await pass()
    expect(mockCreate.mock.calls).toEqual([['b', WARM]])
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // The webapp is who claims spares, and it sends the remembered agent mode —
  // so a spare is warmed with it, where the create route itself would not.
  it('warms a spare as the project\'s untouched create, remembered mode included', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass()
    expect(mockResolveCreate).toHaveBeenCalledWith('p', {}, { modeFromMemory: true })
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
  })

  // A claim cannot convert a spare between modes (the pod spec differs), so
  // one in a mode the project no longer creates in would fill the pool with
  // a spare nothing takes. Every other mismatch is a respawn at claim time.
  it('replaces a spare warmed in another agent mode than the project now uses', async () => {
    vi.mocked(listProjectRows).mockResolvedValue([
      { slug: 'p', lastTool: 'codex', createDefaults: { codex: { mode: 'acp' } } } as unknown as ProjectRow,
    ])
    vi.mocked(getWorkspaceRow).mockResolvedValue({ mode: 'tui' } as WorkspaceRow)
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectSlug: 'p', workspaceId: 's2' })
    expect(mockCreate).toHaveBeenCalledWith('p', WARM)
  })

  it('keeps a spare whose mode matches, or whose row cannot be read', async () => {
    vi.mocked(listProjectRows).mockResolvedValue([
      { slug: 'p', createDefaults: {} } as unknown as ProjectRow,
    ])
    vi.mocked(getWorkspaceRow).mockResolvedValue({ mode: 'tui' } as WorkspaceRow)
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
    // One of two settled: the other stays, so the next tick still sees the
    // outstanding spawn and doesn't stampede.
    expect([...inFlight.values()]).toEqual(['p'])
  })

  // A spawn's pod lists long before its create settles, and a reap then
  // kills it under a create that retries it into the same fate — which is
  // what a stop racing a spawn used to do, three attempts over.
  it('never reaps a spare whose spawn is still in flight, nor counts it twice', async () => {
    mockCreate.mockReturnValue(new Promise<never>(() => { /* never resolves */ }))
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' })])
    await pass()
    const [[, { workspaceId }]] = mockCreate.mock.calls as unknown as [[string, { workspaceId: string }]]
    const warming = pod({ jobName: `yaac-p-${workspaceId}`, workspaceId, prewarmed: true, running: false })

    // Listed beside the real workspace: one spare, not two, so no refill.
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-real', workspaceId: 'r1' }), warming])
    await pass()
    // The real workspace stopped: the project is idle, but the spare is not
    // its to drain until the spawn settles.
    mockWorkspaces.mockResolvedValue([warming])
    await pass()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCleanup).not.toHaveBeenCalled()

    inFlight.clear()
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: `yaac-p-${workspaceId}`, projectSlug: 'p', workspaceId })
  })

  // A restart takes its pod down before the new one runs. The project is not
  // idle for that gap, so its spare stays rather than being drained and
  // re-warmed once the restart is up. A failed restart holds nothing.
  it('keeps an idle project\'s spare while one of its workspaces is restarting', async () => {
    mockWorkspaces.mockResolvedValue([
      pod({ jobName: 'yaac-p-real', workspaceId: 'r1', running: false, terminating: true }),
      pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true }),
    ])
    registerProvisioning({ workspaceId: 'r1', projectSlug: 'p', tool: 'claude', kind: 'restart' })
    await pass()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()

    failProvisioning('r1', 'boom')
    await pass()
    expect(mockCleanup).toHaveBeenCalledWith({ jobName: 'yaac-p-spare', projectSlug: 'p', workspaceId: 's2' })
  })

  it('swallows a failed reap — the stale-session reaper retries', async () => {
    mockWorkspaces.mockResolvedValue([pod({ jobName: 'yaac-p-spare', workspaceId: 's2', prewarmed: true })])
    mockCleanup.mockRejectedValue(new Error('pod gone'))
    await expect(pass()).resolves.toBeUndefined()
    await flush()
  })
})
