import { describe, it, expect } from 'vitest'
import {
  isLocalPreviewUrl,
  hardenGuestWebPreferences,
  sanitizeWebviewSrc,
} from '#webview-guard'

describe('isLocalPreviewUrl', () => {
  it('accepts loopback http(s) origins', () => {
    expect(isLocalPreviewUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalPreviewUrl('http://127.0.0.1:3000/some/path?q=1')).toBe(true)
    expect(isLocalPreviewUrl('https://localhost:8443/')).toBe(true)
    expect(isLocalPreviewUrl('http://[::1]:3000/')).toBe(true)
  })

  it('rejects external hosts and look-alikes', () => {
    expect(isLocalPreviewUrl('http://example.com/')).toBe(false)
    expect(isLocalPreviewUrl('http://localhost.evil.com/')).toBe(false)
    expect(isLocalPreviewUrl('http://127.0.0.1.evil.com/')).toBe(false)
  })

  it('rejects non-http schemes and junk', () => {
    expect(isLocalPreviewUrl('file:///etc/passwd')).toBe(false)
    expect(isLocalPreviewUrl('javascript:alert(1)')).toBe(false)
    expect(isLocalPreviewUrl('about:blank')).toBe(false)
    expect(isLocalPreviewUrl('not a url')).toBe(false)
    expect(isLocalPreviewUrl('')).toBe(false)
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
  it('passes loopback urls through and blanks the rest', () => {
    expect(sanitizeWebviewSrc('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(sanitizeWebviewSrc('http://evil.com/')).toBe('about:blank')
  })
})
