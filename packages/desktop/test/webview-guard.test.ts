import { describe, it, expect } from 'vitest'
import {
  appHostFromUrl,
  isAllowedPreviewUrl,
  hardenGuestWebPreferences,
  sanitizeWebviewSrc,
} from '#webview-guard'

describe('isAllowedPreviewUrl', () => {
  it('accepts loopback http(s) origins', () => {
    expect(isAllowedPreviewUrl('http://localhost:5173/')).toBe(true)
    expect(isAllowedPreviewUrl('http://127.0.0.1:3000/some/path?q=1')).toBe(true)
    expect(isAllowedPreviewUrl('https://localhost:8443/')).toBe(true)
    expect(isAllowedPreviewUrl('http://[::1]:3000/')).toBe(true)
  })

  it('accepts the attached server host when given', () => {
    expect(isAllowedPreviewUrl('http://mybox.tail1234.ts.net:15173/', 'mybox.tail1234.ts.net')).toBe(true)
    expect(isAllowedPreviewUrl('http://localhost:5173/', 'mybox.tail1234.ts.net')).toBe(true)
  })

  it('rejects hosts other than loopback and the attached server host', () => {
    expect(isAllowedPreviewUrl('http://example.com/')).toBe(false)
    expect(isAllowedPreviewUrl('http://example.com/', 'mybox.tail1234.ts.net')).toBe(false)
    expect(isAllowedPreviewUrl('http://localhost.evil.com/')).toBe(false)
    expect(isAllowedPreviewUrl('http://127.0.0.1.evil.com/')).toBe(false)
    expect(isAllowedPreviewUrl('http://mybox.tail1234.ts.net.evil.com/', 'mybox.tail1234.ts.net')).toBe(false)
  })

  it('never widens on an empty app host', () => {
    expect(isAllowedPreviewUrl('http://example.com/', '')).toBe(false)
  })

  it('rejects non-http schemes and junk', () => {
    expect(isAllowedPreviewUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedPreviewUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedPreviewUrl('about:blank')).toBe(false)
    expect(isAllowedPreviewUrl('not a url')).toBe(false)
    expect(isAllowedPreviewUrl('')).toBe(false)
    expect(isAllowedPreviewUrl('file:///x', 'mybox.tail1234.ts.net')).toBe(false)
  })
})

describe('appHostFromUrl', () => {
  it('extracts the hostname from the window url', () => {
    expect(appHostFromUrl('https://mybox.tail1234.ts.net/worktree/x')).toBe('mybox.tail1234.ts.net')
    expect(appHostFromUrl('http://localhost:7433/')).toBe('localhost')
  })

  it('returns undefined for non-network pages', () => {
    expect(appHostFromUrl('data:text/html,<p>splash</p>')).toBeUndefined()
    expect(appHostFromUrl('about:blank')).toBeUndefined()
    expect(appHostFromUrl('')).toBeUndefined()
  })
})

describe('hardenGuestWebPreferences', () => {
  it('strips preload and forces node off / isolation on', () => {
    const prefs: Record<string, unknown> = {
      preload: '/evil/preload.js',
      preloadURL: 'file:///evil',
      nodeIntegration: true,
      contextIsolation: false,
      nodeIntegrationInSubFrames: true,
    }
    hardenGuestWebPreferences(prefs)
    expect(prefs.preload).toBeUndefined()
    expect(prefs.preloadURL).toBeUndefined()
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.nodeIntegrationInSubFrames).toBe(false)
    expect(prefs.contextIsolation).toBe(true)
  })
})

describe('sanitizeWebviewSrc', () => {
  it('passes allowed urls through and blanks the rest', () => {
    expect(sanitizeWebviewSrc('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(sanitizeWebviewSrc('http://evil.com/')).toBe('about:blank')
    expect(sanitizeWebviewSrc('http://mybox.tail1234.ts.net:15173/', 'mybox.tail1234.ts.net'))
      .toBe('http://mybox.tail1234.ts.net:15173/')
    expect(sanitizeWebviewSrc('http://evil.com/', 'mybox.tail1234.ts.net')).toBe('about:blank')
  })
})
