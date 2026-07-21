import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadPersistedLayouts, persistLayouts } from '#store'
import { addColumn, singleColumn } from '#lib/layout'

// Minimal localStorage stand-in for the node test environment.
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  }
  return store
}

describe('layout persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('round-trips workspaces (including null = emptied)', () => {
    const layouts = {
      s1: addColumn(singleColumn('agent'), 'shell:shell'),
      s2: null,
    }
    persistLayouts(layouts)
    expect(loadPersistedLayouts()).toEqual(layouts)
  })

  it('drops structurally invalid workspaces on load', () => {
    store.set('yaac.layouts.v2', JSON.stringify({
      ok: [{ tabs: ['agent'], active: 'agent' }],
      // active not a member of tabs
      bad1: [{ tabs: ['x'], active: 'y' }],
      // empty tabs
      bad2: [{ tabs: [], active: 'x' }],
      // not an array of groups
      bad3: 42,
      // old binary-tree shape is no longer valid
      bad4: { type: 'leaf', target: 'agent' },
    }))
    expect(loadPersistedLayouts()).toEqual({ ok: [{ tabs: ['agent'], active: 'agent' }] })
  })

  it('ignores layouts saved under the old (v1) key', () => {
    store.set('yaac.layouts.v1', JSON.stringify({ s1: { type: 'leaf', target: 'agent' } }))
    expect(loadPersistedLayouts()).toEqual({})
  })

  it('survives garbage and absence', () => {
    expect(loadPersistedLayouts()).toEqual({})
    store.set('yaac.layouts.v2', '{{{')
    expect(loadPersistedLayouts()).toEqual({})
    store.set('yaac.layouts.v2', '"a string"')
    expect(loadPersistedLayouts()).toEqual({})
  })

  it('is a no-op without localStorage', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadPersistedLayouts()).toEqual({})
    expect(() => persistLayouts({ s: singleColumn('agent') })).not.toThrow()
  })
})
