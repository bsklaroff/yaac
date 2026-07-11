import { describe, it, expect } from 'vitest'
import {
  PREVIEW_TARGET,
  isPreviewTarget,
  previewLabel,
  previewUrl,
  normalizePreviewNav,
  firstDetectedPort,
} from '@/frontend/lib/preview'

describe('isPreviewTarget', () => {
  it('recognizes the preview target only', () => {
    expect(isPreviewTarget(PREVIEW_TARGET)).toBe(true)
    expect(isPreviewTarget('preview')).toBe(true)
    expect(isPreviewTarget('agent')).toBe(false)
    expect(isPreviewTarget('window:@3')).toBe(false)
  })
})

describe('previewLabel', () => {
  it('labels with the port when present', () => {
    expect(previewLabel(5173)).toBe('Preview :5173')
  })
  it('falls back to a bare label with no port', () => {
    expect(previewLabel(undefined)).toBe('Preview')
  })
})

describe('previewUrl', () => {
  it('builds the loopback url for a host port', () => {
    expect(previewUrl(15173)).toBe('http://localhost:15173/')
  })
})

describe('normalizePreviewNav', () => {
  it('uses a full http(s) url as-is', () => {
    expect(normalizePreviewNav('https://example.com/x', 15173)).toBe('https://example.com/x')
    expect(normalizePreviewNav('http://localhost:3000/', 15173)).toBe('http://localhost:3000/')
  })
  it('treats other input as a path on the current host port', () => {
    expect(normalizePreviewNav('/dashboard', 15173)).toBe('http://localhost:15173/dashboard')
    expect(normalizePreviewNav('settings', 15173)).toBe('http://localhost:15173/settings')
  })
  it('returns null when empty or when a path has no port', () => {
    expect(normalizePreviewNav('   ', 15173)).toBeNull()
    expect(normalizePreviewNav('/x', undefined)).toBeNull()
  })
})

describe('firstDetectedPort', () => {
  it('returns the first detected container port', () => {
    expect(firstDetectedPort([
      { containerPort: 5432, detected: false },
      { containerPort: 5173, detected: true },
      { containerPort: 8080, detected: true },
    ])).toBe(5173)
  })
  it('returns null when nothing is detected', () => {
    expect(firstDetectedPort([{ containerPort: 3000 }])).toBeNull()
    expect(firstDetectedPort([])).toBeNull()
  })
})
