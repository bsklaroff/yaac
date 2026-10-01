import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadChatFullWidth, persistChatFullWidth } from '#lib/store'

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

describe('chat width persistence', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = stubLocalStorage()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('defaults to centered when unset or unreadable', () => {
    expect(loadChatFullWidth()).toBe(false)
    store.set('yaac.chatfullwidth.v1', 'garbage')
    expect(loadChatFullWidth()).toBe(false)
  })

  it('round-trips the preference', () => {
    persistChatFullWidth(true)
    expect(loadChatFullWidth()).toBe(true)
    persistChatFullWidth(false)
    expect(loadChatFullWidth()).toBe(false)
  })

  it('defaults to centered when localStorage is missing or throws', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadChatFullWidth()).toBe(false)
    expect(() => persistChatFullWidth(true)).not.toThrow()

    const blocked = (): never => { throw new Error('blocked') }
    ;(globalThis as Record<string, unknown>).localStorage = { getItem: blocked, setItem: blocked }
    expect(loadChatFullWidth()).toBe(false)
    expect(() => persistChatFullWidth(true)).not.toThrow()
  })
})
