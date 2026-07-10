import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadPinnedUsageMetric, persistPinnedUsageMetric, useUiStore } from '@/frontend/store'

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

describe('pinned-usage persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('round-trips a pinned metric key', () => {
    persistPinnedUsageMetric('weekly_scoped:Fable')
    expect(loadPinnedUsageMetric()).toBe('weekly_scoped:Fable')
  })

  it('clears the stored pin on null', () => {
    persistPinnedUsageMetric('session')
    persistPinnedUsageMetric(null)
    expect(loadPinnedUsageMetric()).toBeNull()
    expect(store.has('yaac.pinnedusage.v1')).toBe(false)
  })

  it('is a no-op without localStorage', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadPinnedUsageMetric()).toBeNull()
    expect(() => persistPinnedUsageMetric('session')).not.toThrow()
  })

  it('the store setter persists as it sets', () => {
    useUiStore.setState({ pinnedUsageMetric: null })
    useUiStore.getState().setPinnedUsageMetric('session')
    expect(store.get('yaac.pinnedusage.v1')).toBe('session')
    expect(useUiStore.getState().pinnedUsageMetric).toBe('session')
    useUiStore.getState().setPinnedUsageMetric(null)
    expect(store.has('yaac.pinnedusage.v1')).toBe(false)
  })
})
