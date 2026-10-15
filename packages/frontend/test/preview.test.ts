import { describe, it, expect, vi } from 'vitest'
import {
  isPreviewTarget,
  previewLabel,
  previewTarget,
  previewTargetPort,
  previewUrl,
  normalizePreviewNav,
} from '#lib/preview'

describe('previewTarget', () => {
  it('names one pane per port, recognized and read back', () => {
    expect(previewTarget(5173)).toBe('preview:5173')
    expect(isPreviewTarget(previewTarget(5173))).toBe(true)
    expect(previewTargetPort(previewTarget(5173))).toBe(5173)
    expect(isPreviewTarget('preview:abc')).toBe(false)
    expect(isPreviewTarget('preview:')).toBe(false)
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
  it('labels a bare workspace port, and falls back to a bare label with no port', () => {
    expect(previewLabel(5173)).toBe('Preview :5173')
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
