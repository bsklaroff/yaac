import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadPersistedLayouts, persistLayouts } from '@/frontend/store'
import { leaf, splitLeaf } from '@/frontend/lib/layout'

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

  it('round-trips layouts (including null = emptied)', () => {
    const layouts = {
      s1: splitLeaf(leaf('agent'), 'agent', 'shell:shell', 'row'),
      s2: null,
    }
    persistLayouts(layouts)
    expect(loadPersistedLayouts()).toEqual(layouts)
  })

  it('drops structurally invalid trees on load', () => {
    store.set('yaac.layouts.v1', JSON.stringify({
      ok: { type: 'leaf', target: 'agent' },
      bad1: { type: 'split', dir: 'diagonal', ratio: 0.5, a: { type: 'leaf', target: 'x' }, b: { type: 'leaf', target: 'y' } },
      bad2: { type: 'leaf' },
      bad3: 42,
    }))
    expect(loadPersistedLayouts()).toEqual({ ok: { type: 'leaf', target: 'agent' } })
  })

  it('survives garbage and absence', () => {
    expect(loadPersistedLayouts()).toEqual({})
    store.set('yaac.layouts.v1', '{{{')
    expect(loadPersistedLayouts()).toEqual({})
    store.set('yaac.layouts.v1', '"a string"')
    expect(loadPersistedLayouts()).toEqual({})
  })

  it('is a no-op without localStorage', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadPersistedLayouts()).toEqual({})
    expect(() => persistLayouts({ s: leaf('agent') })).not.toThrow()
  })
})
