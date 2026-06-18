import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadViewMode, mergeProvisioning, useUiStore } from '@/frontend/store'
import type { ProvisioningSessionEntry } from '@/shared/types'

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
    sessionId, projectSlug: 'p', tool: 'claude' as const, createdAt: '2026-01-01 00:00:00', prompt: 'hi',
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

  it('reconnectTerminal bumps only the target session nonce', () => {
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t1')
    useUiStore.getState().reconnectTerminal('t2')
    expect(useUiStore.getState().terminalNonces).toEqual({ t1: 2, t2: 1 })
  })

  it('setSessionLayout stores per-session workspace trees (null = emptied)', () => {
    const tree = { type: 'split' as const, dir: 'row' as const, ratio: 0.5,
      a: { type: 'leaf' as const, target: 'agent' },
      b: { type: 'leaf' as const, target: 'shell:shell' } }
    useUiStore.getState().setSessionLayout('s1', tree)
    useUiStore.getState().setSessionLayout('s2', null)
    expect(useUiStore.getState().layouts).toEqual({ s1: tree, s2: null })
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
})
