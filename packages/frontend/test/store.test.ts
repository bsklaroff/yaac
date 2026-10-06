import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isUnreadWaiting, isUnseenDeath, defaultViewMode, mergeProvisioning, paneViewKey,
  resolveVacantSelection, unreadWaitingByProject, useUiStore,
} from '#lib/store'
import type { ListedAgentStatus, ProvisioningWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'
import { PREVIEW_TARGET } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/panes'

const initial = useUiStore.getState()

beforeEach(() => {
  useUiStore.setState(initial, true)
})

describe('pending-delete tracking', () => {
  it('beginDelete adds an id, with no duplicates', () => {
    useUiStore.getState().beginDelete('a')
    useUiStore.getState().beginDelete('a')
    useUiStore.getState().beginDelete('b')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['a', 'b'])
  })

  it('endDelete removes a tracked id and is a no-op for untracked ones', () => {
    useUiStore.getState().beginDelete('a')
    useUiStore.getState().beginDelete('b')
    useUiStore.getState().endDelete('a')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['b'])
    useUiStore.getState().endDelete('missing')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['b'])
  })
})

describe('optimistic deleted tracking', () => {
  const entry = (workspaceId: string) => ({
    workspaceId, projectId: 'p', tool: 'claude' as const, createdAt: '2026-01-01 00:00:00',
    prompt: 'hi', seen: false, agentSessions: [],
  })

  it('addOptimisticStopped prepends, with no duplicates', () => {
    useUiStore.getState().addOptimisticStopped(entry('a'))
    useUiStore.getState().addOptimisticStopped(entry('b'))
    useUiStore.getState().addOptimisticStopped(entry('a'))
    expect(useUiStore.getState().optimisticStopped.map((e) => e.workspaceId)).toEqual(['b', 'a'])
  })

  it('removeOptimisticStopped drops a tracked id and no-ops otherwise', () => {
    useUiStore.getState().addOptimisticStopped(entry('a'))
    useUiStore.getState().addOptimisticStopped(entry('b'))
    useUiStore.getState().removeOptimisticStopped('a')
    expect(useUiStore.getState().optimisticStopped.map((e) => e.workspaceId)).toEqual(['b'])
    useUiStore.getState().removeOptimisticStopped('missing')
    expect(useUiStore.getState().optimisticStopped.map((e) => e.workspaceId)).toEqual(['b'])
  })
})

describe('read-waiting tracking', () => {
  it('markWaitingRead stores the spell timestamp, overwriting an older one', () => {
    useUiStore.getState().markWaitingRead('a', 100)
    useUiStore.getState().markWaitingRead('a', 100)
    useUiStore.getState().markWaitingRead('b', 200)
    useUiStore.getState().markWaitingRead('a', 300)
    expect(useUiStore.getState().readWaiting).toEqual({ a: 300, b: 200 })
  })

  it('syncWaitingRead drops marks whose spell is over', () => {
    useUiStore.getState().markWaitingRead('a', 100)
    useUiStore.getState().markWaitingRead('b', 200)
    useUiStore.getState().markWaitingRead('c', 300)
    // 'a' ran again (gone from the waiting set); 'b' is waiting anew with a
    // fresh spell; 'c' is unchanged; 'd' was never read — must not be added.
    useUiStore.getState().syncWaitingRead([
      { workspaceId: 'b', waitingSinceMs: 250 },
      { workspaceId: 'c', waitingSinceMs: 300 },
      { workspaceId: 'd', waitingSinceMs: 400 },
    ])
    expect(useUiStore.getState().readWaiting).toEqual({ c: 300 })
  })

  it('syncWaitingRead keeps the same state when nothing changed', () => {
    useUiStore.getState().markWaitingRead('a', 100)
    const before = useUiStore.getState()
    useUiStore.getState().syncWaitingRead([
      { workspaceId: 'a', waitingSinceMs: 100 },
      { workspaceId: 'other', waitingSinceMs: 500 },
    ])
    expect(useUiStore.getState()).toBe(before)
  })
})

describe('isUnseenDeath', () => {
  it('flags an abnormal death the server has not marked seen', () => {
    expect(isUnseenDeath({ deathReason: 'oom', seen: false })).toBe(true)
    expect(isUnseenDeath({ deathReason: 'oom', seen: true })).toBe(false)
  })

  it('never flags a plain user delete (no deathReason), seen or not', () => {
    expect(isUnseenDeath({ seen: false })).toBe(false)
    expect(isUnseenDeath({ deathReason: undefined, seen: false })).toBe(false)
  })
})

describe('isUnreadWaiting', () => {
  it('flags a waiting session with no mark or a mark from an older spell', () => {
    const s = { workspaceId: 'a', status: 'waiting' as const, waitingSinceMs: 200 }
    expect(isUnreadWaiting(s, {})).toBe(true)
    expect(isUnreadWaiting(s, { a: 100 })).toBe(true)
    expect(isUnreadWaiting(s, { a: 200 })).toBe(false)
  })

  it('never flags a running session', () => {
    expect(isUnreadWaiting({ workspaceId: 'a', status: 'running' }, {})).toBe(false)
  })

  it('normalizes a missing waitingSinceMs to 0', () => {
    const s = { workspaceId: 'a', status: 'waiting' as const }
    expect(isUnreadWaiting(s, {})).toBe(true)
    expect(isUnreadWaiting(s, { a: 0 })).toBe(false)
  })
})

describe('unreadWaitingByProject', () => {
  const s = (workspaceId: string, projectId: string, status: ListedAgentStatus, waitingSinceMs?: number) =>
    ({ workspaceId, projectId, status, waitingSinceMs })

  it('counts only unread waiting sessions, grouped by project', () => {
    const sessions = [
      s('w1', 'p1', 'waiting', 100),
      s('w2', 'p1', 'waiting', 200),
      s('r1', 'p1', 'running'),
      s('w3', 'p2', 'waiting', 300),
    ]
    expect(unreadWaitingByProject(sessions, { w2: 200 })).toEqual({ p1: 1, p2: 1 })
  })

  it('counts an asking session even once viewed, and no background one', () => {
    const sessions = [{ ...s('a1', 'p1', 'waiting', 100), asking: true as const }, s('b1', 'p1', 'background')]
    expect(unreadWaitingByProject(sessions, { a1: 100 })).toEqual({ p1: 1 })
  })

  it('re-counts a session whose mark is from an earlier spell', () => {
    const sessions = [s('w1', 'p1', 'waiting', 500)]
    expect(unreadWaitingByProject(sessions, { w1: 100 })).toEqual({ p1: 1 })
  })

  it('omits projects with no unread waiting sessions', () => {
    const sessions = [s('w1', 'p1', 'waiting', 100), s('r1', 'p2', 'running')]
    expect(unreadWaitingByProject(sessions, { w1: 100 })).toEqual({})
  })

  it('excludes sessions whose delete is in flight (pendingDeleteIds)', () => {
    // A just-deleted session, not yet reflected in the snapshot, must not
    // count on its way out.
    const sessions = [s('w1', 'p1', 'waiting'), s('w2', 'p1', 'waiting', 200)]
    expect(unreadWaitingByProject(sessions, {}, ['w1'])).toEqual({ p1: 1 })
  })

  it('excludes server-marked stopping sessions', () => {
    const sessions = [
      { workspaceId: 'w1', projectId: 'p1', status: 'waiting' as const, stopping: true },
      s('w2', 'p1', 'waiting', 200),
    ]
    expect(unreadWaitingByProject(sessions, {})).toEqual({ p1: 1 })
  })
})

describe('resolveVacantSelection', () => {
  const args = (over: Partial<Parameters<typeof resolveVacantSelection>[0]> = {}) => ({
    previousProjectId: 'p1',
    activeProjectId: 'p1',
    selectedWorkspaceId: 'w1',
    rowIds: ['w1', 'w2'],
    claims: {},
    inFlight: [],
    ...over,
  })

  it('leaves a live selection — and a provisioning one — alone', () => {
    expect(resolveVacantSelection(args())).toBeNull()
    // Mid-create: the provisioning row is a sidebar row like any other.
    expect(resolveVacantSelection(args({ selectedWorkspaceId: 'new', rowIds: ['new', 'w1'] }))).toBeNull()
  })

  it('takes the topmost row when the open workspace vanished', () => {
    // e.g. a CLI delete or the stale reaper: the selection is set but its
    // workspace is no longer a selectable row. Topmost means the sidebar's first
    // row; the caller passes display order.
    expect(resolveVacantSelection(args({ selectedWorkspaceId: 'gone' }))).toBe('w1')
    expect(resolveVacantSelection(args({ selectedWorkspaceId: 'gone', rowIds: ['w2', 'w1'] }))).toBe('w2')
  })

  it('follows a create into the prewarmed spare it claimed, once the spare lists', () => {
    const claims = { req: 'spare' }
    // The create's row resolved but the spare hasn't listed yet: wait for it
    // rather than handing the pane to some other row.
    expect(resolveVacantSelection(args({ selectedWorkspaceId: 'req', claims }))).toBeNull()
    expect(resolveVacantSelection(args({
      selectedWorkspaceId: 'req', claims, rowIds: ['w1', 'spare'],
    }))).toBe('spare')
    // A project switch is not the create resolving, so take the top row.
    expect(resolveVacantSelection(args({
      previousProjectId: 'p0', selectedWorkspaceId: 'req', claims,
    }))).toBe('w1')
  })

  it('holds a vanished selection whose provision is still in flight', () => {
    // The snapshot has neither the row nor its workspace. The create's result
    // may still say where it went, so the pane is not handed away.
    expect(resolveVacantSelection(args({ selectedWorkspaceId: 'req', inFlight: ['req'] }))).toBeNull()
  })

  it('takes the topmost row of a project switched into', () => {
    expect(resolveVacantSelection(args({
      previousProjectId: 'p0', selectedWorkspaceId: null,
    }))).toBe('w1')
  })

  it('stays empty on a first paint, and on a deselect', () => {
    // Nothing persisted: no previous project, nothing selected, so nobody has
    // chosen a workspace yet.
    expect(resolveVacantSelection(args({
      previousProjectId: null, selectedWorkspaceId: null,
    }))).toBeNull()
    // Same project, selection cleared by the user (a dismissed provisioning row).
    expect(resolveVacantSelection(args({ selectedWorkspaceId: null }))).toBeNull()
  })

  it('has nothing to fill the pane with when no row is selectable', () => {
    expect(resolveVacantSelection(args({ selectedWorkspaceId: 'gone', rowIds: [] }))).toBeNull()
    expect(resolveVacantSelection(args({ activeProjectId: null }))).toBeNull()
  })
})

describe('selection + project switching', () => {
  it('selectWorkspace sets the selected id', () => {
    useUiStore.getState().selectWorkspace('s1')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('s1')
  })

  it('setActiveProject clears the open session', () => {
    useUiStore.getState().selectWorkspace('s1')
    useUiStore.getState().setActiveProject('proj')
    expect(useUiStore.getState().activeProjectId).toBe('proj')
    expect(useUiStore.getState().selectedWorkspaceId).toBeNull()
  })

  it('openWorkspace sets both project and session', () => {
    useUiStore.getState().openWorkspace('proj', 's2')
    expect(useUiStore.getState().activeProjectId).toBe('proj')
    expect(useUiStore.getState().selectedWorkspaceId).toBe('s2')
  })

  it('selectWorkspace and openWorkspace each bump focusNonce', () => {
    expect(useUiStore.getState().focusNonce).toBe(0)
    useUiStore.getState().selectWorkspace('s1')
    expect(useUiStore.getState().focusNonce).toBe(1)
    // Re-selecting the same session still bumps, so clicking it re-focuses.
    useUiStore.getState().selectWorkspace('s1')
    expect(useUiStore.getState().focusNonce).toBe(2)
    useUiStore.getState().openWorkspace('proj', 's2')
    expect(useUiStore.getState().focusNonce).toBe(3)
  })

  it('reconnectTerminal bumps only the target session nonce', () => {
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t2')
    expect(useUiStore.getState().terminalNonces).toEqual({ t1: 2, t2: 1 })
  })

  it('setWorkspaceLayout stores per-workspace pane layouts', () => {
    const ws = [
      { tabs: ['agent'], active: 'agent' },
      { tabs: ['shell:shell'], active: 'shell:shell' },
    ]
    useUiStore.getState().setWorkspaceLayout('s1', ws)
    useUiStore.getState().setWorkspaceLayout('s2', [])
    expect(useUiStore.getState().layouts).toEqual({ s1: ws, s2: [] })
  })
})

describe('optimistic provisioning tracking', () => {
  const entry = (workspaceId: string, over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
    workspaceId, projectId: 'p', tool: 'claude', kind: 'create', message: 'Starting…',
    createdAt: '2026-01-01 00:00:00', ...over,
  })

  it('addOptimisticProvisioning appends, with no duplicates', () => {
    useUiStore.getState().addOptimisticProvisioning(entry('a'))
    useUiStore.getState().addOptimisticProvisioning(entry('b'))
    useUiStore.getState().addOptimisticProvisioning(entry('a'))
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.workspaceId)).toEqual(['a', 'b'])
  })

  it('updateOptimisticProvisioning patches message/error and no-ops for unknown ids', () => {
    useUiStore.getState().addOptimisticProvisioning(entry('a'))
    useUiStore.getState().updateOptimisticProvisioning('a', { message: 'Pulling…' })
    expect(useUiStore.getState().optimisticProvisioning[0].message).toBe('Pulling…')
    useUiStore.getState().updateOptimisticProvisioning('a', { error: 'boom' })
    expect(useUiStore.getState().optimisticProvisioning[0].error).toBe('boom')
    useUiStore.getState().updateOptimisticProvisioning('missing', { message: 'x' })
    expect(useUiStore.getState().optimisticProvisioning).toHaveLength(1)
  })

  it('removeOptimisticProvisioning drops a tracked id and no-ops otherwise', () => {
    useUiStore.getState().addOptimisticProvisioning(entry('a'))
    useUiStore.getState().addOptimisticProvisioning(entry('b'))
    useUiStore.getState().removeOptimisticProvisioning('a')
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.workspaceId)).toEqual(['b'])
    useUiStore.getState().removeOptimisticProvisioning('missing')
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.workspaceId)).toEqual(['b'])
  })
})

describe('reconcileSnapshot', () => {
  const prov = (workspaceId: string, over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
    workspaceId, projectId: 'p', tool: 'claude', kind: 'create', message: 'Starting…',
    createdAt: '2026-01-01 00:00:00', ...over,
  })
  const live = (workspaceId: string) => ({ workspaceId }) as WorkspaceListEntry

  it('folds a snapshot into the stops, provisioning rows and claims it settles', () => {
    const s = useUiStore.getState()
    s.beginDelete('stopping')
    s.beginDelete('gone')
    for (const id of ['listed', 'provisioning', 'pending']) s.addOptimisticProvisioning(prov(id))
    s.recordClaim('failed', 'spare-1')
    s.recordClaim('listed', 'spare-2')
    s.reconcileSnapshot({
      workspaces: [live('stopping'), live('listed')],
      provisioning: [prov('provisioning', { claimedId: 'spare-3' }), prov('failed', { error: 'boom' })],
    })
    const after = useUiStore.getState()
    // A stop stays tracked while the workspace is listed.
    expect(after.pendingDeleteIds).toEqual(['stopping'])
    // An optimistic row goes once the server lists the id either way.
    expect(after.optimisticProvisioning.map((e) => e.workspaceId)).toEqual(['pending'])
    // Claims follow the server's rows; a failed or self-listed create forgets its claim.
    expect(after.claims).toEqual({ provisioning: 'spare-3' })
  })

  it('does not mark a stop for a workspace the last snapshot no longer lists', () => {
    useUiStore.getState().reconcileSnapshot({ workspaces: [live('a')], provisioning: [] })
    useUiStore.getState().beginDelete('died-meanwhile')
    useUiStore.getState().beginDelete('a')
    expect(useUiStore.getState().pendingDeleteIds).toEqual(['a'])
  })

  it('keeps state identity when nothing changes', () => {
    useUiStore.getState().addOptimisticProvisioning(prov('pending'))
    useUiStore.getState().reconcileSnapshot({ workspaces: [], provisioning: [] })
    const before = useUiStore.getState()
    useUiStore.getState().reconcileSnapshot({ workspaces: [], provisioning: [] })
    expect(useUiStore.getState()).toBe(before)
  })
})

describe('mergeProvisioning', () => {
  const e = (workspaceId: string, over: Partial<ProvisioningWorkspaceEntry> = {}): ProvisioningWorkspaceEntry => ({
    workspaceId, projectId: 'p', tool: 'claude', kind: 'create', message: 'm',
    createdAt: '2026-01-01 00:00:00', ...over,
  })

  it('dedupes by id with the snapshot row winning', () => {
    const merged = mergeProvisioning([e('a', { message: 'live' })], [e('a', { message: 'optim' }), e('b')])
    expect(merged.find((x) => x.workspaceId === 'a')?.message).toBe('live')
    expect(merged.map((x) => x.workspaceId)).toEqual(['a', 'b'])
  })

  it('sorts by createdAt then id', () => {
    const merged = mergeProvisioning([], [
      e('b', { createdAt: '2026-01-01 00:00:02' }),
      e('a', { createdAt: '2026-01-01 00:00:01' }),
    ])
    expect(merged.map((x) => x.workspaceId)).toEqual(['a', 'b'])
  })
})

describe('view mode (tiles vs tabs)', () => {
  it('defaults by viewport width when nothing is persisted', () => {
    expect(defaultViewMode(1440)).toBe('tiles')
    expect(defaultViewMode(800)).toBe('tabs')
  })

  it('setActiveTab is per workspace', () => {
    useUiStore.getState().setActiveTab('s1', 'shell:shell')
    useUiStore.getState().setActiveTab('s2', 'agent')
    expect(useUiStore.getState().activeTabs).toEqual({ s1: 'shell:shell', s2: 'agent' })
  })

  it('setActiveTab records without focusing and no-ops on the same value', () => {
    const nonce = useUiStore.getState().focusNonce
    useUiStore.getState().setActiveTab('s1', 'agent')
    expect(useUiStore.getState().focusNonce).toBe(nonce)
    // A no-op re-record keeps state identity (no re-render); the focus recorder
    // fires again on every shortcut-driven focus.
    const before = useUiStore.getState().activeTabs
    useUiStore.getState().setActiveTab('s1', 'agent')
    expect(useUiStore.getState().activeTabs).toBe(before)
  })

  it('focusTerminal records the active terminal and bumps focusNonce', () => {
    const nonce = useUiStore.getState().focusNonce
    useUiStore.getState().focusTerminal('s1', 'window:@2')
    expect(useUiStore.getState().activeTabs.s1).toBe('window:@2')
    expect(useUiStore.getState().focusNonce).toBe(nonce + 1)
    // Re-focusing the active terminal still bumps, so Alt+N re-focuses.
    useUiStore.getState().focusTerminal('s1', 'window:@2')
    expect(useUiStore.getState().focusNonce).toBe(nonce + 2)
  })

  it('setPaneView merges into one pane’s view state and no-ops on the same values', () => {
    const key = paneViewKey('s1', 'changes')
    useUiStore.getState().setPaneView(key, { expanded: ['a.ts', 'b.ts'] })
    useUiStore.getState().setPaneView(key, { scroll: 120 })
    useUiStore.getState().setPaneView(paneViewKey('s2', 'files'), { showIgnored: true })
    expect(useUiStore.getState().paneView).toEqual({
      's1|changes': { expanded: ['a.ts', 'b.ts'], scroll: 120 },
      's2|files': { showIgnored: true },
    })
    // Re-recording the same values keeps state identity (no needless render).
    const before = useUiStore.getState().paneView
    useUiStore.getState().setPaneView(key, { scroll: 120 })
    expect(useUiStore.getState().paneView).toBe(before)
  })

  it('setChangesBase sets a per-session base branch and clears it when unset', () => {
    useUiStore.getState().setChangesBase('s1', 'dev')
    useUiStore.getState().setChangesBase('s2', 'main')
    expect(useUiStore.getState().changesBase).toEqual({ s1: 'dev', s2: 'main' })
    useUiStore.getState().setChangesBase('s1', undefined)
    expect(useUiStore.getState().changesBase).toEqual({ s2: 'main' })
  })

  it('setFilesFindPending raises and clears the focus request, no-oping on the same value', () => {
    expect(useUiStore.getState().filesFindPending).toBe(false)
    useUiStore.getState().setFilesFindPending(true)
    expect(useUiStore.getState().filesFindPending).toBe(true)
    useUiStore.getState().setFilesFindPending(false)
    expect(useUiStore.getState().filesFindPending).toBe(false)
    // Clearing an already-clear request keeps state identity (no needless render).
    const before = useUiStore.getState()
    useUiStore.getState().setFilesFindPending(false)
    expect(useUiStore.getState()).toBe(before)
  })

  it('openPreview and openChanges add their pane once, as a focused column', () => {
    useUiStore.getState().openPreview('s1', 3000)
    useUiStore.getState().openChanges('s1')
    useUiStore.getState().openPreview('s1', 4000)
    const state = useUiStore.getState()
    expect(state.layouts.s1).toEqual([
      { tabs: ['agent'], active: 'agent' },
      { tabs: [PREVIEW_TARGET], active: PREVIEW_TARGET },
      { tabs: [CHANGES_TARGET], active: CHANGES_TARGET },
    ])
    expect(state.activeTabs.s1).toBe(PREVIEW_TARGET)
    // The first port opened sticks; reopening only refocuses.
    expect(state.previewPort.s1).toBe(3000)
  })

  it('openFile places a file beside the explorer, then as a tab of the file column, and focuses it', () => {
    useUiStore.getState().openFiles('s1')
    useUiStore.getState().openFile('s1', 'src/a.ts')
    useUiStore.getState().openFile('s1', 'src/b.ts')
    expect(useUiStore.getState().layouts.s1).toEqual([
      { tabs: ['agent'], active: 'agent' },
      { tabs: ['files'], active: 'files' },
      { tabs: ['file:src/a.ts', 'file:src/b.ts'], active: 'file:src/b.ts' },
    ])
    expect(useUiStore.getState().activeTabs.s1).toBe('file:src/b.ts')
    // Opening one already open only surfaces it.
    useUiStore.getState().openFile('s1', 'src/a.ts')
    expect(useUiStore.getState().layouts.s1?.[2]).toEqual({ tabs: ['file:src/a.ts', 'file:src/b.ts'], active: 'file:src/a.ts' })
  })

  it('renameFiles moves the open panes and dirty marks under a renamed folder', () => {
    useUiStore.getState().openFile('s1', 'src/a.ts')
    useUiStore.getState().openFile('s1', 'other.ts')
    useUiStore.getState().setFileDirty('s1', 'src/a.ts', true)
    useUiStore.getState().renameFiles('s1', 'src', 'lib')
    const state = useUiStore.getState()
    expect(state.layouts.s1?.flatMap((g) => g.tabs)).toEqual(['agent', 'file:lib/a.ts', 'file:other.ts'])
    expect(state.dirtyFiles).toEqual({ 's1|lib/a.ts': true })
    expect(state.activeTabs.s1).toBe('file:other.ts')
    useUiStore.getState().closeFiles('s1', ['lib/a.ts'])
    expect(useUiStore.getState().layouts.s1?.flatMap((g) => g.tabs)).toEqual(['agent', 'file:other.ts'])
    expect(useUiStore.getState().dirtyFiles).toEqual({})
  })
})

describe('theme preference', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('setThemePref updates state and persists', () => {
    const store = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
    }
    useUiStore.getState().setThemePref('light')
    expect(useUiStore.getState().themePref).toBe('light')
    expect(store.get('yaac.theme.v1')).toBe('light')
    // applyThemeAttribute's DOM write is covered in theme.test.ts (jsdom).
  })

  it('defaults to system', () => {
    expect(useUiStore.getState().themePref).toBe('system')
  })
})

describe('settings modal state', () => {
  it('openSettings opens on the last-viewed section when none is given', () => {
    useUiStore.getState().setSettingsSection('shortcuts')
    useUiStore.getState().openSettings()
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('shortcuts')
    expect(state.settingsFocusTool).toBeNull()
  })

  it('openSettings can target a section with a tool sign-in focus', () => {
    useUiStore.getState().openSettings('credentials', 'codex')
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(true)
    expect(state.settingsSection).toBe('credentials')
    expect(state.settingsFocusTool).toBe('codex')
  })

  it('openSettings can target a project\'s git credential instead', () => {
    useUiStore.getState().openSettings('credentials', undefined, 'proj')
    const state = useUiStore.getState()
    expect(state.settingsFocusTool).toBeNull()
    expect(state.settingsFocusProject).toBe('proj')
  })

  it('closeSettings clears the focus but keeps the section sticky', () => {
    useUiStore.getState().openSettings('credentials', 'codex', 'proj')
    useUiStore.getState().closeSettings()
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(false)
    expect(state.settingsFocusTool).toBeNull()
    expect(state.settingsFocusProject).toBeNull()
    expect(state.settingsSection).toBe('credentials')
  })

  it('a plain reopen after a focused one carries no stale focus tool', () => {
    useUiStore.getState().openSettings('credentials', 'codex')
    useUiStore.getState().closeSettings()
    useUiStore.getState().openSettings()
    expect(useUiStore.getState().settingsFocusTool).toBeNull()
  })
})
