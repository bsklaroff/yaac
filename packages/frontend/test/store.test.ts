import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isUnreadWaiting, isUnseenDeath, loadViewMode, mergeProvisioning, resolveAttentionTarget,
  resolveNewSessionTool, unreadWaitingBySlug, useUiStore,
} from '#store'
import type { ProvisioningSessionEntry } from '@yaac/shared/types'

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
  const entry = (sessionId: string) => ({
    sessionId, projectSlug: 'p', tool: 'claude' as const, createdAt: '2026-01-01 00:00:00',
    prompt: 'hi', seen: false,
  })

  it('addOptimisticDeleted prepends, with no duplicates', () => {
    useUiStore.getState().addOptimisticDeleted(entry('a'))
    useUiStore.getState().addOptimisticDeleted(entry('b'))
    useUiStore.getState().addOptimisticDeleted(entry('a'))
    expect(useUiStore.getState().optimisticDeleted.map((e) => e.sessionId)).toEqual(['b', 'a'])
  })

  it('removeOptimisticDeleted drops a tracked id and no-ops otherwise', () => {
    useUiStore.getState().addOptimisticDeleted(entry('a'))
    useUiStore.getState().addOptimisticDeleted(entry('b'))
    useUiStore.getState().removeOptimisticDeleted('a')
    expect(useUiStore.getState().optimisticDeleted.map((e) => e.sessionId)).toEqual(['b'])
    useUiStore.getState().removeOptimisticDeleted('missing')
    expect(useUiStore.getState().optimisticDeleted.map((e) => e.sessionId)).toEqual(['b'])
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
      { sessionId: 'b', waitingSinceMs: 250 },
      { sessionId: 'c', waitingSinceMs: 300 },
      { sessionId: 'd', waitingSinceMs: 400 },
    ])
    expect(useUiStore.getState().readWaiting).toEqual({ c: 300 })
  })

  it('syncWaitingRead keeps the same state when nothing changed', () => {
    useUiStore.getState().markWaitingRead('a', 100)
    const before = useUiStore.getState()
    useUiStore.getState().syncWaitingRead([
      { sessionId: 'a', waitingSinceMs: 100 },
      { sessionId: 'other', waitingSinceMs: 500 },
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
    const s = { sessionId: 'a', status: 'waiting' as const, waitingSinceMs: 200 }
    expect(isUnreadWaiting(s, {})).toBe(true)
    expect(isUnreadWaiting(s, { a: 100 })).toBe(true)
    expect(isUnreadWaiting(s, { a: 200 })).toBe(false)
  })

  it('never flags a running session', () => {
    expect(isUnreadWaiting({ sessionId: 'a', status: 'running' }, {})).toBe(false)
  })

  it('normalizes a missing waitingSinceMs to 0', () => {
    const s = { sessionId: 'a', status: 'waiting' as const }
    expect(isUnreadWaiting(s, {})).toBe(true)
    expect(isUnreadWaiting(s, { a: 0 })).toBe(false)
  })
})

describe('unreadWaitingBySlug', () => {
  const s = (sessionId: string, projectSlug: string, status: 'running' | 'waiting', waitingSinceMs?: number) =>
    ({ sessionId, projectSlug, status, waitingSinceMs })

  it('counts only unread waiting sessions, grouped by project', () => {
    const sessions = [
      s('w1', 'p1', 'waiting', 100),
      s('w2', 'p1', 'waiting', 200),
      s('r1', 'p1', 'running'),
      s('w3', 'p2', 'waiting', 300),
    ]
    expect(unreadWaitingBySlug(sessions, { w2: 200 })).toEqual({ p1: 1, p2: 1 })
  })

  it('re-counts a session whose mark is from an earlier spell', () => {
    const sessions = [s('w1', 'p1', 'waiting', 500)]
    expect(unreadWaitingBySlug(sessions, { w1: 100 })).toEqual({ p1: 1 })
  })

  it('omits projects with no unread waiting sessions', () => {
    const sessions = [s('w1', 'p1', 'waiting', 100), s('r1', 'p2', 'running')]
    expect(unreadWaitingBySlug(sessions, { w1: 100 })).toEqual({})
  })

  it('excludes sessions whose delete is in flight (pendingDeleteIds)', () => {
    // A just-deleted session, not yet reflected in the snapshot, must not
    // count on its way out.
    const sessions = [s('w1', 'p1', 'waiting'), s('w2', 'p1', 'waiting', 200)]
    expect(unreadWaitingBySlug(sessions, {}, ['w1'])).toEqual({ p1: 1 })
  })

  it('excludes server-marked terminating sessions', () => {
    const sessions = [
      { sessionId: 'w1', projectSlug: 'p1', status: 'waiting' as const, terminating: true },
      s('w2', 'p1', 'waiting', 200),
    ]
    expect(unreadWaitingBySlug(sessions, {})).toEqual({ p1: 1 })
  })
})

describe('resolveAttentionTarget', () => {
  const s = (sessionId: string, status: 'running' | 'waiting', waitingSinceMs?: number) =>
    ({ sessionId, status, waitingSinceMs })

  it('prefers the topmost unread-waiting session', () => {
    // r1 is topmost overall, w1 is waiting-but-read, w2 is unread waiting.
    const sessions = [s('r1', 'running'), s('w1', 'waiting', 100), s('w2', 'waiting', 200)]
    expect(resolveAttentionTarget(sessions, { w1: 100 })).toBe('w2')
  })

  it('picks the topmost unread when several are unread', () => {
    const sessions = [s('w1', 'waiting', 100), s('w2', 'waiting', 200)]
    expect(resolveAttentionTarget(sessions, {})).toBe('w1')
  })

  it('falls back to the topmost waiting when all waiting are read', () => {
    const sessions = [s('r1', 'running'), s('w1', 'waiting', 100), s('w2', 'waiting', 200)]
    expect(resolveAttentionTarget(sessions, { w1: 100, w2: 200 })).toBe('w1')
  })

  it('falls back to the topmost running when nothing is waiting', () => {
    const sessions = [s('r1', 'running'), s('r2', 'running')]
    expect(resolveAttentionTarget(sessions, {})).toBe('r1')
  })

  it('returns null when there are no sessions', () => {
    expect(resolveAttentionTarget([], {})).toBeNull()
  })
})

describe('selection + project switching', () => {
  it('selectSession sets the selected id', () => {
    useUiStore.getState().selectSession('s1')
    expect(useUiStore.getState().selectedSessionId).toBe('s1')
  })

  it('setActiveProject clears the open session', () => {
    useUiStore.getState().selectSession('s1')
    useUiStore.getState().setActiveProject('proj')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
    expect(useUiStore.getState().selectedSessionId).toBeNull()
  })

  it('openSession sets both project and session', () => {
    useUiStore.getState().openSession('proj', 's2')
    expect(useUiStore.getState().activeProjectSlug).toBe('proj')
    expect(useUiStore.getState().selectedSessionId).toBe('s2')
  })

  it('selectSession and openSession each bump focusNonce', () => {
    expect(useUiStore.getState().focusNonce).toBe(0)
    useUiStore.getState().selectSession('s1')
    expect(useUiStore.getState().focusNonce).toBe(1)
    // Re-selecting the same session still bumps — clicking it re-focuses.
    useUiStore.getState().selectSession('s1')
    expect(useUiStore.getState().focusNonce).toBe(2)
    useUiStore.getState().openSession('proj', 's2')
    expect(useUiStore.getState().focusNonce).toBe(3)
  })

  it('reconnectTerminal bumps only the target session nonce', () => {
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t2')
    expect(useUiStore.getState().terminalNonces).toEqual({ t1: 2, t2: 1 })
  })

  it('setSessionLayout stores per-session workspaces (null = emptied)', () => {
    const ws = [
      { tabs: ['agent'], active: 'agent' },
      { tabs: ['shell:shell'], active: 'shell:shell' },
    ]
    useUiStore.getState().setSessionLayout('s1', ws)
    useUiStore.getState().setSessionLayout('s2', null)
    expect(useUiStore.getState().layouts).toEqual({ s1: ws, s2: null })
  })
})

describe('optimistic provisioning tracking', () => {
  const entry = (sessionId: string, over: Partial<ProvisioningSessionEntry> = {}): ProvisioningSessionEntry => ({
    sessionId, projectSlug: 'p', tool: 'claude', kind: 'create', message: 'Starting…',
    createdAt: '2026-01-01 00:00:00', ...over,
  })

  it('addOptimisticProvisioning appends, with no duplicates', () => {
    useUiStore.getState().addOptimisticProvisioning(entry('a'))
    useUiStore.getState().addOptimisticProvisioning(entry('b'))
    useUiStore.getState().addOptimisticProvisioning(entry('a'))
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.sessionId)).toEqual(['a', 'b'])
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
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.sessionId)).toEqual(['b'])
    useUiStore.getState().removeOptimisticProvisioning('missing')
    expect(useUiStore.getState().optimisticProvisioning.map((e) => e.sessionId)).toEqual(['b'])
  })
})

describe('mergeProvisioning', () => {
  const e = (sessionId: string, over: Partial<ProvisioningSessionEntry> = {}): ProvisioningSessionEntry => ({
    sessionId, projectSlug: 'p', tool: 'claude', kind: 'create', message: 'm',
    createdAt: '2026-01-01 00:00:00', ...over,
  })

  it('dedupes by id with the snapshot row winning', () => {
    const merged = mergeProvisioning([e('a', { message: 'live' })], [e('a', { message: 'optim' }), e('b')])
    expect(merged.find((x) => x.sessionId === 'a')?.message).toBe('live')
    expect(merged.map((x) => x.sessionId)).toEqual(['a', 'b'])
  })

  it('sorts by createdAt then id', () => {
    const merged = mergeProvisioning([], [
      e('b', { createdAt: '2026-01-01 00:00:02' }),
      e('a', { createdAt: '2026-01-01 00:00:01' }),
    ])
    expect(merged.map((x) => x.sessionId)).toEqual(['a', 'b'])
  })
})

describe('view mode (tiles vs tabs)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('defaults by viewport width when nothing is persisted', () => {
    expect(loadViewMode(1440)).toBe('tiles')
    expect(loadViewMode(800)).toBe('tabs')
  })

  it('prefers the persisted value over the width default', () => {
    const store = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
    }
    store.set('yaac.viewmode.v1', 'tabs')
    expect(loadViewMode(1440)).toBe('tabs')
    store.set('yaac.viewmode.v1', 'garbage')
    expect(loadViewMode(1440)).toBe('tiles')
  })

  it('setViewMode updates state and persists; setActiveTab is per session', () => {
    const store = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
    }
    useUiStore.getState().setViewMode('tabs')
    expect(useUiStore.getState().viewMode).toBe('tabs')
    expect(store.get('yaac.viewmode.v1')).toBe('tabs')
    useUiStore.getState().setActiveTab('s1', 'shell:shell')
    useUiStore.getState().setActiveTab('s2', 'agent')
    expect(useUiStore.getState().activeTabs).toEqual({ s1: 'shell:shell', s2: 'agent' })
  })

  it('setActiveTab records without focusing and no-ops on the same value', () => {
    const nonce = useUiStore.getState().focusNonce
    useUiStore.getState().setActiveTab('s1', 'agent')
    expect(useUiStore.getState().focusNonce).toBe(nonce)
    // No-op re-record keeps the state object identity (re-render-free): the
    // focus recorder re-fires on every shortcut-driven focus.
    const before = useUiStore.getState().activeTabs
    useUiStore.getState().setActiveTab('s1', 'agent')
    expect(useUiStore.getState().activeTabs).toBe(before)
  })

  it('focusTerminal records the active terminal and bumps focusNonce', () => {
    const nonce = useUiStore.getState().focusNonce
    useUiStore.getState().focusTerminal('s1', 'window:@2')
    expect(useUiStore.getState().activeTabs.s1).toBe('window:@2')
    expect(useUiStore.getState().focusNonce).toBe(nonce + 1)
    // Re-focusing the already-active terminal still bumps — Alt+N re-focuses.
    useUiStore.getState().focusTerminal('s1', 'window:@2')
    expect(useUiStore.getState().focusNonce).toBe(nonce + 2)
  })

  it('setChangesExpanded stores the expanded-files set per session', () => {
    useUiStore.getState().setChangesExpanded('s1', ['a.ts', 'b.ts'])
    useUiStore.getState().setChangesExpanded('s2', [])
    expect(useUiStore.getState().changesExpanded).toEqual({ s1: ['a.ts', 'b.ts'], s2: [] })
    // A later call replaces that session's set without touching the others.
    useUiStore.getState().setChangesExpanded('s1', ['a.ts'])
    expect(useUiStore.getState().changesExpanded).toEqual({ s1: ['a.ts'], s2: [] })
  })

  it('setChangesScroll records the Changes-pane scroll offset per session and no-ops on the same value', () => {
    useUiStore.getState().setChangesScroll('s1', 120)
    useUiStore.getState().setChangesScroll('s2', 0)
    expect(useUiStore.getState().changesScroll).toEqual({ s1: 120, s2: 0 })
    // Re-recording the same offset keeps state identity (no needless render).
    const before = useUiStore.getState().changesScroll
    useUiStore.getState().setChangesScroll('s1', 120)
    expect(useUiStore.getState().changesScroll).toBe(before)
  })

  it('setChangesBase sets a per-session base branch and clears it when unset', () => {
    useUiStore.getState().setChangesBase('s1', 'dev')
    useUiStore.getState().setChangesBase('s2', 'main')
    expect(useUiStore.getState().changesBase).toEqual({ s1: 'dev', s2: 'main' })
    // Passing undefined removes just that session's entry.
    useUiStore.getState().setChangesBase('s1', undefined)
    expect(useUiStore.getState().changesBase).toEqual({ s2: 'main' })
  })

  it('setChangesFind sets a per-session find query and clears it on the empty string', () => {
    useUiStore.getState().setChangesFind('s1', 'foo')
    useUiStore.getState().setChangesFind('s2', 'bar')
    expect(useUiStore.getState().changesFind).toEqual({ s1: 'foo', s2: 'bar' })
    // An empty query removes just that session's entry.
    useUiStore.getState().setChangesFind('s1', '')
    expect(useUiStore.getState().changesFind).toEqual({ s2: 'bar' })
  })

  it('setChangesFindPending raises and clears the focus request, no-oping on the same value', () => {
    expect(useUiStore.getState().changesFindPending).toBe(false)
    useUiStore.getState().setChangesFindPending(true)
    expect(useUiStore.getState().changesFindPending).toBe(true)
    useUiStore.getState().setChangesFindPending(false)
    expect(useUiStore.getState().changesFindPending).toBe(false)
    // Clearing an already-clear flag keeps state identity (no needless render).
    const before = useUiStore.getState()
    useUiStore.getState().setChangesFindPending(false)
    expect(useUiStore.getState()).toBe(before)
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
    // (applyThemeAttribute's <html data-theme> write is covered in
    // theme.test.ts under jsdom; there is no document here.)
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

  it('closeSettings clears the focus tool but keeps the section sticky', () => {
    useUiStore.getState().openSettings('credentials', 'codex')
    useUiStore.getState().closeSettings()
    const state = useUiStore.getState()
    expect(state.settingsOpen).toBe(false)
    expect(state.settingsFocusTool).toBeNull()
    expect(state.settingsSection).toBe('credentials')
  })

  it('a plain reopen after a focused one carries no stale focus tool', () => {
    useUiStore.getState().openSettings('credentials', 'codex')
    useUiStore.getState().closeSettings()
    useUiStore.getState().openSettings()
    expect(useUiStore.getState().settingsFocusTool).toBeNull()
  })
})

describe('resolveNewSessionTool', () => {
  const sessions = [
    { sessionId: 's-claude', tool: 'claude' as const },
    { sessionId: 's-codex', tool: 'codex' as const },
  ]

  it("uses the selected session's tool when its credentials are configured", () => {
    expect(resolveNewSessionTool(sessions, 's-codex', new Set(['claude', 'codex'])))
      .toBe('codex')
  })

  it('falls back to claude when nothing is selected', () => {
    expect(resolveNewSessionTool(sessions, null, new Set(['claude']))).toBe('claude')
  })

  it('returns null when the target tool has no credentials', () => {
    expect(resolveNewSessionTool(sessions, 's-codex', new Set(['claude']))).toBeNull()
    expect(resolveNewSessionTool(sessions, null, new Set(['codex']))).toBeNull()
  })

  it('returns null while the auth list is still unknown (empty set)', () => {
    expect(resolveNewSessionTool(sessions, 's-claude', new Set())).toBeNull()
  })
})
