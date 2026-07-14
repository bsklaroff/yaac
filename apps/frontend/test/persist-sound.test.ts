import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadSoundEnabled, persistSoundEnabled, useUiStore } from '#store'

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

describe('sound persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('defaults on when unset', () => {
    expect(loadSoundEnabled()).toBe(true)
  })

  it('round-trips a disabled preference', () => {
    persistSoundEnabled(false)
    expect(loadSoundEnabled()).toBe(false)
    persistSoundEnabled(true)
    expect(loadSoundEnabled()).toBe(true)
  })

  it('defaults on without localStorage', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadSoundEnabled()).toBe(true)
    expect(() => persistSoundEnabled(false)).not.toThrow()
  })

  it('the store setter persists as it sets', () => {
    useUiStore.setState({ soundEnabled: true })
    useUiStore.getState().setSoundEnabled(false)
    expect(store.get('yaac.sound.v1')).toBe('0')
    expect(useUiStore.getState().soundEnabled).toBe(false)
  })
})
