import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadReadWaiting, persistReadWaiting, useUiStore } from '@/frontend/store'

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

describe('read-waiting persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('round-trips read marks', () => {
    persistReadWaiting({ a: 100, b: 200 })
    expect(loadReadWaiting()).toEqual({ a: 100, b: 200 })
  })

  it('drops non-number values on load', () => {
    store.set('yaac.readwaiting.v1', JSON.stringify({ a: 100, b: 'nope', c: null }))
    expect(loadReadWaiting()).toEqual({ a: 100 })
  })

  it('survives garbage, absence, and pre-spell array data', () => {
    expect(loadReadWaiting()).toEqual({})
    store.set('yaac.readwaiting.v1', '{{{')
    expect(loadReadWaiting()).toEqual({})
    store.set('yaac.readwaiting.v1', '"a string"')
    expect(loadReadWaiting()).toEqual({})
    store.set('yaac.readwaiting.v1', '["a","b"]')
    expect(loadReadWaiting()).toEqual({})
  })

  it('is a no-op without localStorage', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadReadWaiting()).toEqual({})
    expect(() => persistReadWaiting({ a: 1 })).not.toThrow()
  })

  it('store changes persist via the subscription', () => {
    useUiStore.setState({ readWaiting: {} })
    useUiStore.getState().markWaitingRead('a', 100)
    expect(store.get('yaac.readwaiting.v1')).toBe('{"a":100}')
    useUiStore.getState().syncWaitingRead([])
    expect(store.get('yaac.readwaiting.v1')).toBe('{}')
  })
})
