import { describe, it, expect, vi } from 'vitest'
import {
  PREVIEW_TARGET,
  isPreviewTarget,
  previewLabel,
  previewUrl,
  normalizePreviewNav,
} from '#lib/preview'

describe('isPreviewTarget', () => {
  it('recognizes the preview target only', () => {
    expect(isPreviewTarget(PREVIEW_TARGET)).toBe(true)
    expect(isPreviewTarget('preview')).toBe(true)
    expect(isPreviewTarget('agent')).toBe(false)
    expect(isPreviewTarget('window:@3')).toBe(false)
  })
})

describe('previewLabel', () => {
  it('labels with the workspace port, adding a differing local port only in the desktop app', () => {
    expect(previewLabel({ containerPort: 5173, hostPort: 5173 })).toBe('Preview :5173')
    expect(previewLabel({ containerPort: 5173, hostPort: 5174 })).toBe('Preview :5173')
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Electron/33.0.0')
    expect(previewLabel({ containerPort: 5173, hostPort: 5174 })).toBe('Preview :5173→:5174')
    vi.restoreAllMocks()
  })
  it('falls back to a bare label with no port', () => {
    expect(previewLabel(undefined)).toBe('Preview')
  })
})

describe('previewUrl', () => {
  it('builds a plain-http loopback url for a host port', () => {
    expect(previewUrl(15173)).toBe('http://127.0.0.1:15173/')
  })
})

describe('normalizePreviewNav', () => {
  it('uses a full http(s) url as-is', () => {
    expect(normalizePreviewNav('https://example.com/x', 15173)).toBe('https://example.com/x')
    expect(normalizePreviewNav('http://localhost:3000/', 15173)).toBe('http://localhost:3000/')
  })
  it('treats other input as a path on the current host port', () => {
    expect(normalizePreviewNav('/dashboard', 15173)).toBe('http://127.0.0.1:15173/dashboard')
    expect(normalizePreviewNav('settings', 15173)).toBe('http://127.0.0.1:15173/settings')
  })
  it('returns null when empty or when a path has no port', () => {
    expect(normalizePreviewNav('   ', 15173)).toBeNull()
    expect(normalizePreviewNav('/x', undefined)).toBeNull()
  })
})
