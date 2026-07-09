// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadThemePref, persistThemePref, applyThemeAttribute } from '@/frontend/lib/theme'

beforeEach(() => localStorage.clear())

describe('loadThemePref', () => {
  it('defaults to system when unset', () => {
    expect(loadThemePref()).toBe('system')
  })

  it('reads a stored valid preference', () => {
    for (const pref of ['system', 'light', 'dark'] as const) {
      localStorage.setItem('yaac.theme.v1', pref)
      expect(loadThemePref()).toBe(pref)
    }
  })

  it('falls back to system for an unrecognized value', () => {
    localStorage.setItem('yaac.theme.v1', 'sepia')
    expect(loadThemePref()).toBe('system')
  })
})

describe('persistThemePref', () => {
  it('round-trips through localStorage', () => {
    persistThemePref('light')
    expect(localStorage.getItem('yaac.theme.v1')).toBe('light')
    expect(loadThemePref()).toBe('light')
  })
})

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
