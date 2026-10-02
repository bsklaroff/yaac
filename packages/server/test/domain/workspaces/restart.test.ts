import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as dbModule from '#db'

// Real, but a case can make clearing the stop fail.
vi.mock('#db', async (importOriginal) => {
  const actual = await importOriginal<typeof dbModule>()
  return { ...actual, clearWorkspaceStopped: vi.fn(actual.clearWorkspaceStopped) }
})
import { resolveRestartTarget, restartWorkspace } from '#domain/workspaces/restart'
import { createWorkspace } from '#domain/workspaces/create'
import {
  clearAllProvisioningForTests,
  inFlightWorkspaceIds,
  listProvisioning,
  registerProvisioning,
} from '#domain/workspaces/provisioning'
import { applyWorkspaceEvent, clearWorkspaceStopped, createWorkspaceGroup, getWorkspaceRow } from '#db'
import { closeDb } from '#db/client'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'

/**
 * A restart resolves its target, tears down the old unit, creates under the
 * same id, and only then clears the stop record. Create and teardown run for
 * real against the fake driver, over a real project.
 */
let tmpDir: string
/** The unit the driver reports running, if any. */
let live: RuntimeHandle | undefined
/** What the driver saw, in order. */
let calls: string[]

function installDriver(overrides: Partial<WorkspaceDriver> = {}): void {
  installFakeWorkspaceDriver({
    find: (id) => Promise.resolve(live?.workspaceId === id ? live : undefined),
    findForTeardown: (id) => Promise.resolve(live?.workspaceId === id
      ? { workspaceId: id, projectSlug: live.projectSlug, unitName: live.jobName }
      : undefined),
    destroy: (target) => {
      calls.push(`destroy ${target.unitName} in-flight=${inFlightWorkspaceIds().join(',')}`)
      return Promise.resolve(true)
    },
    launch: (spec) => {
      calls.push(`launch ${spec.workspaceId}`)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, jobName: `yaac-demo-${spec.workspaceId}` }))
    },
    exec: (_jobName, cmd) => {
      calls.push(cmd)
      return Promise.resolve({ stdout: '', stderr: '' })
    },
    ...overrides,
  })
}

/** A workspace created and then stopped, with its unit gone. */
async function stoppedWorkspace(workspaceId: string): Promise<void> {
  await createWorkspace('demo', { workspaceId })
  await applyWorkspaceEvent({ type: 'workspace-stopped', projectSlug: 'demo', workspaceId })
  calls = []
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  clearAllProvisioningForTests()
  live = undefined
  calls = []
  installDriver()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  // A restart that stops before create returns leaves its mark behind.
  clearAllProvisioningForTests()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('restartWorkspace', () => {
  it('tears down the live unit while marked in flight, resumes every active conversation, and clears the stop', async () => {
    await stoppedWorkspace('wt-1')
    const sessions = [
      { tool: 'codex' as const, agentSessionId: 'wt-1', mode: 'tui' as const },
      { tool: 'claude' as const, agentSessionId: 'conv-2', mode: 'tui' as const },
    ]
    await applyWorkspaceEvent({ type: 'sessions-launched', projectSlug: 'demo', workspaceId: 'wt-1', sessions })
    live = handleFixture({ workspaceId: 'wt-1', jobName: 'yaac-demo-wt-1', tool: 'codex' })
    const progress: string[] = []

    // Addressed by prefix, as the CLI usually does.
    const result = await restartWorkspace('wt', { onProgress: (m) => progress.push(m) })

    expect(result).toMatchObject({ workspaceId: 'wt-1', tool: 'codex' })
    // `inFlightWorkspaceIds` is all that keeps the stale reaper from
    // deleting the dirs the create is about to mount.
    expect(calls[0]).toBe('destroy yaac-demo-wt-1 in-flight=wt-1')
    expect(calls).toContain('launch wt-1')
    // Each conversation comes back in its own window, in order.
    const windows = calls.find((c) => c.includes('respawn-window'))!
    expect(windows).toContain('-t yaac:codex')
    expect(windows).toContain('-n claude-2')
    expect(progress).toEqual(expect.arrayContaining([
      'Stopping session job yaac-demo-wt-1...', 'Restoring 2 agent sessions...',
    ]))
    expect((await getWorkspaceRow('demo', 'wt-1'))?.stoppedAt).toBeUndefined()
    // `buildSnapshot` hides a workspace that still has a row, so a leftover
    // would show "Starting…" forever.
    expect(listProvisioning()).toEqual([])
  })

  // The workspace is running by then, so a lost clear must not report it
  // as failed.
  it('succeeds when clearing the stop record fails', async () => {
    await stoppedWorkspace('wt-clear')
    vi.mocked(clearWorkspaceStopped).mockRejectedValueOnce(new Error('db write failed'))
    expect(await restartWorkspace('wt-clear')).toMatchObject({ workspaceId: 'wt-clear' })
    expect(listProvisioning()).toEqual([])
  })

  it('relaunches a stopped workspace with no unit to tear down, in its recorded posture', async () => {
    await createWorkspace('demo', { workspaceId: 'wt-2', permissionMode: 'plan' })
    await applyWorkspaceEvent({ type: 'workspace-stopped', projectSlug: 'demo', workspaceId: 'wt-2' })
    calls = []

    await restartWorkspace('wt-2')

    expect(calls.some((c) => c.startsWith('destroy'))).toBe(false)
    expect(calls.find((c) => c.includes('respawn-window'))).toContain('--permission-mode plan')
    expect((await getWorkspaceRow('demo', 'wt-2'))?.stoppedAt).toBeUndefined()
  })

  it('keeps the stop record, and a failed provisioning row, when the resume fails', async () => {
    await stoppedWorkspace('wt-3')
    installDriver({ awaitReady: () => Promise.reject(new Error('image pull failed')) })

    await expect(restartWorkspace('wt-3')).rejects.toThrow('image pull failed')

    expect((await getWorkspaceRow('demo', 'wt-3'))?.stoppedAt).toBeInstanceOf(Date)
    expect(listProvisioning()).toEqual([expect.objectContaining({ workspaceId: 'wt-3', error: 'image pull failed' })])
    // The rollback already tore everything down, so it no longer shields
    // anything from the reaper.
    expect(inFlightWorkspaceIds()).toEqual([])
  })

  // The snapshot hides the workspace while it restarts, so the provisioning
  // row must carry its sidebar group. Read mid-flight, since success removes
  // the row.
  it('registers itself under the resolved project and the row\'s group', async () => {
    await stoppedWorkspace('wt-4')
    const group = await createWorkspaceGroup('demo', 'Reviews', 'wt-4')
    let rows: ReturnType<typeof listProvisioning> = []
    installDriver({ prepareSubstrate: () => { rows = listProvisioning(); return Promise.reject(new Error('stop here')) } })

    await expect(restartWorkspace('wt-4')).rejects.toThrow('stop here')

    expect(rows).toEqual([expect.objectContaining({
      workspaceId: 'wt-4', projectSlug: 'demo', tool: 'claude', kind: 'restart', groupId: group.groupId,
    })])
  })

  // The route registers up front and the sidebar sorts oldest first, so
  // re-registering would move the row to the bottom.
  it('leaves a pre-registered row in its original sidebar position', async () => {
    await stoppedWorkspace('wt-5')
    registerProvisioning({ workspaceId: 'wt-5', projectSlug: 'demo', tool: 'claude', kind: 'restart' })
    registerProvisioning({ workspaceId: 'younger', projectSlug: 'demo', tool: 'claude', kind: 'create' })
    let order: string[] = []
    installDriver({
      prepareSubstrate: () => { order = listProvisioning().map((r) => r.workspaceId); return Promise.reject(new Error('stop')) },
    })

    await expect(restartWorkspace('wt-5')).rejects.toThrow('stop')

    expect(order).toEqual(['wt-5', 'younger'])
  })

  it('refuses an unknown workspace without touching anything', async () => {
    await expect(restartWorkspace('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls).toEqual([])
    expect(listProvisioning()).toEqual([])
  })
})

describe('resolveRestartTarget', () => {
  // Prefixes are expanded over rows first; the runtime sees only exact ids.
  it('expands a unique prefix before asking the runtime, and refuses an ambiguous one', async () => {
    await stoppedWorkspace('sid-1')
    const group = await createWorkspaceGroup('demo', 'Reviews', 'sid-1')
    // A live unit names the tool it runs, whatever the row's first
    // conversation was; the group lives only on the row.
    live = handleFixture({ workspaceId: 'sid-1', jobName: 'yaac-demo-sid-1', tool: 'opencode' })
    expect(await resolveRestartTarget('sid')).toEqual({
      projectSlug: 'demo', workspaceId: 'sid-1', tool: 'opencode', jobName: 'yaac-demo-sid-1', groupId: group.groupId,
    })

    await stoppedWorkspace('sid-2')
    await expect(resolveRestartTarget('sid')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('answers a stopped workspace from its row: the first conversation\'s tool, and its group', async () => {
    // opencode leaves no transcript to read the tool back from.
    await createWorkspace('demo', { workspaceId: 'oc-1', tool: 'opencode' })
    const group = await createWorkspaceGroup('demo', 'Reviews', 'oc-1')
    expect(await resolveRestartTarget('oc-1')).toEqual({
      projectSlug: 'demo', workspaceId: 'oc-1', tool: 'opencode', jobName: null, groupId: group.groupId,
    })
  })

  it('falls through to the row when the runtime is unreachable', async () => {
    await stoppedWorkspace('wt-x')
    installDriver({ find: () => Promise.reject(new Error('connection refused')) })
    expect(await resolveRestartTarget('wt-x')).toMatchObject({ workspaceId: 'wt-x', jobName: null })
  })
})
