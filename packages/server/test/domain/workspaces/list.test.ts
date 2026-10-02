import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
// Only the runtime is faked; the listing joins real rows with real status
// observation.
import { markWorkspaceTerminating, isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { setAgentStatus, _resetWorkspaceStatusStoreForTests } from '#runtime/status/status-store'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { recordAgentSessions } from '#db/agent-session-store'
import {
  listActiveWorkspaces,
  _clearListActiveInflightForTests,
} from '#domain/workspaces/list'
import type { RuntimeHandle, WorkspaceDriver } from '#drivers/contract'
import { recordTestProject } from '@yaac/test-utils/project-fixture'

/** Install a runtime listing `handles`. */
function running(handles: RuntimeHandle[], overrides: Partial<WorkspaceDriver> = {}): void {
  installFakeWorkspaceDriver({ list: () => Promise.resolve(handles), ...overrides })
}

/** A running workspace of project demo. */
const live = (workspaceId: string, over: Partial<RuntimeHandle> = {}): RuntimeHandle =>
  handleFixture({ workspaceId, jobName: `yaac-demo-${workspaceId}`, ...over })

describe('listActiveWorkspaces', () => {
  let tmpDir: string

  beforeEach(async () => {
    running([])
    tmpDir = await createTempDataDir()
    _clearListActiveInflightForTests()
    _clearTerminatingForTests()
    _resetWorkspaceStatusStoreForTests()
  })

  afterEach(async () => {
    vi.useRealTimers()
    _clearTerminatingForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('filters by a recorded project, and refuses an unknown one', async () => {
    await recordTestProject('valid')
    expect((await listActiveWorkspaces('valid')).workspaces).toEqual([])
    await expect(listActiveWorkspaces('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('renders a stopping pod as a non-interactive stopping row, not stale', async () => {
    await recordTestProject('demo')
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'dying' })
    await recordAgentSessions('demo', 'dying', [
      { tool: 'claude', agentSessionId: 'dying', model: 'claude-sonnet-5' },
    ])
    running([live('dying', { running: false, terminating: true })])
    const result = await listActiveWorkspaces()
    expect(result.stale).toEqual([])
    expect(result.workspaces).toHaveLength(1)
    const row = result.workspaces[0]
    expect(row.workspaceId).toBe('dying')
    expect(row.stopping).toBe(true)
    // Forced 'running' with no waiting stamp, so no attention badge fires.
    expect(row.status).toBe('running')
    expect(row.waitingSinceMs).toBeUndefined()
    // Its conversations stay listed, so the row keeps naming its model, but
    // carry no live status of their own.
    expect(row.agentSessions).toHaveLength(1)
    expect(row.agentSessions[0]).toMatchObject({ model: 'claude-sonnet-5' })
    expect(row.agentSessions[0].status).toBeUndefined()
  })

  it('prunes a stopping mark once its pod is gone', async () => {
    markWorkspaceTerminating('ghost')
    // Its unit is already torn down.
    await listActiveWorkspaces()
    expect(isWorkspaceTerminating('ghost')).toBe(false)
  })

  it('returns empty arrays with no session pods', async () => {
    const result = await listActiveWorkspaces()
    expect(result.workspaces).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('hides prewarmed spares from the active session list', async () => {
    running([live('spare1', { prewarmed: true })])
    const result = await listActiveWorkspaces()
    // Filtered out before classify, so it never reaches the status probes.
    expect(result.workspaces).toEqual([])
    expect(result.stale).toEqual([])
  })

  it('surfaces the base branch recorded at create time', async () => {
    await recordTestProject('demo')
    await recordWorkspaceCreated({
      projectSlug: 'demo', workspaceId: 'tracked', baseBranch: 'release/2.x',
    })
    await recordWorkspaceCreated({ projectSlug: 'demo', workspaceId: 'norecord' })

    running([live('tracked'), live('norecord')])
    const result = await listActiveWorkspaces('demo')
    const bySession = new Map(result.workspaces.map((s) => [s.workspaceId, s]))
    expect(bySession.get('tracked')?.baseBranch).toBe('release/2.x')
    expect(bySession.get('norecord')?.baseBranch).toBeUndefined()
  })

  it('carries each workspace\'s forwarded ports', async () => {
    running([live('withports'), live('noports')], {
      forwardedPorts: (id) => Promise.resolve(id === 'withports' ? [{ containerPort: 8787, hostPort: 9787 }] : []),
    })
    const result = await listActiveWorkspaces()
    const bySession = new Map(result.workspaces.map((s) => [s.workspaceId, s]))
    expect(bySession.get('withports')?.forwardedPorts).toEqual([{ containerPort: 8787, hostPort: 9787 }])
    expect(bySession.get('noports')?.forwardedPorts).toEqual([])
  })

  // The status store's spell, projected into the entry: stamped when a wait
  // begins and stable across listings.
  it('stamps a waiting workspace with when its wait began', async () => {
    running([live('s1')])
    /** The entry's status and stamp, with the single-flight slot cleared so
     *  the listing sees the store as it is now. */
    const stamp = async (): Promise<[string | undefined, number | undefined]> => {
      _clearListActiveInflightForTests()
      const [w] = (await listActiveWorkspaces()).workspaces
      return [w?.status, w?.waitingSinceMs]
    }
    // A booting workspace (no store entry) lists as waiting, unstamped.
    expect(await stamp()).toEqual(['waiting', undefined])

    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    vi.setSystemTime(60_000)
    expect(await stamp()).toEqual(['waiting', 1_000])

    // Running is unstamped; a fresh wait restamps.
    setAgentStatus('demo', 's1', '%0', 'running')
    expect(await stamp()).toEqual(['running', undefined])
    vi.setSystemTime(2_000)
    setAgentStatus('demo', 's1', '%0', 'waiting')
    expect(await stamp()).toEqual(['waiting', 2_000])
  })

  it('shares one listing between overlapping calls with the same filter, and only those', async () => {
    await recordTestProject('other')
    const pending: Array<(handles: RuntimeHandle[]) => void> = []
    running([], { list: () => new Promise((resolve) => { pending.push(resolve) }) })

    const [a, b, other] = [listActiveWorkspaces(), listActiveWorkspaces(), listActiveWorkspaces('other')]
    // The filtered call checks its project first.
    await vi.waitFor(() => { expect(pending).toHaveLength(2) })
    for (const finish of pending) finish([])
    expect(await a).toBe(await b)
    expect(await other).not.toBe(await a)

    // A settled call frees the slot, even when it rejected.
    let lists = 0
    running([], { list: () => { lists++; return Promise.reject(new Error('cluster down')) } })
    await expect(listActiveWorkspaces()).rejects.toThrow('cluster down')
    await expect(listActiveWorkspaces()).rejects.toThrow('cluster down')
    expect(lists).toBe(2)
  })
})
