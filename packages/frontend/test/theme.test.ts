import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveEffectiveTheme } from '#lib/theme'

beforeEach(() => localStorage.clear())

describe('resolveEffectiveTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it('returns a forced light/dark attribute directly', () => {
    document.documentElement.setAttribute('data-theme', 'light')
    expect(resolveEffectiveTheme()).toBe('light')
    document.documentElement.setAttribute('data-theme', 'dark')
    expect(resolveEffectiveTheme()).toBe('dark')
  })

  it('follows the OS under system', () => {
    document.documentElement.setAttribute('data-theme', 'system')
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'), addEventListener() {}, removeEventListener() {},
    }))
    expect(resolveEffectiveTheme()).toBe('dark')
    vi.stubGlobal('matchMedia', (_q: string) => ({
      matches: false, addEventListener() {}, removeEventListener() {},
    }))
    expect(resolveEffectiveTheme()).toBe('light')
  })
})
