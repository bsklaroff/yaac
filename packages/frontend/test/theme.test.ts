// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyThemeAttribute, resolveEffectiveTheme } from '#lib/theme'

beforeEach(() => localStorage.clear())

describe('applyThemeAttribute', () => {
  it('sets data-theme on the given root', () => {
    const root = document.createElement('html')
    applyThemeAttribute('dark', root)
    expect(root.getAttribute('data-theme')).toBe('dark')
  })

  it('defaults to the document element', () => {
    applyThemeAttribute('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('resolveEffectiveTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
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
