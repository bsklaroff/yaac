import { describe, it, expect } from 'vitest'
import {
  previewTarget,
  isPreviewTarget,
  previewPort,
  previewLabel,
  previewUrl,
  normalizePreviewNav,
} from '@/frontend/lib/preview'

describe('previewTarget / isPreviewTarget', () => {
  it('mints and recognizes a preview target', () => {
    expect(previewTarget(5173)).toBe('preview:5173')
    expect(isPreviewTarget('preview:5173')).toBe(true)
    expect(isPreviewTarget('agent')).toBe(false)
    expect(isPreviewTarget('window:@3')).toBe(false)
  })
})

describe('previewPort', () => {
  it('reads the container port back', () => {
    expect(previewPort('preview:5173')).toBe(5173)
    expect(previewPort('preview:3000')).toBe(3000)
  })
  it('returns null for non-preview or malformed targets', () => {
    expect(previewPort('agent')).toBeNull()
    expect(previewPort('preview:')).toBeNull()
    expect(previewPort('preview:nope')).toBeNull()
    expect(previewPort('preview:-1')).toBeNull()
  })
})

describe('previewLabel', () => {
  it('labels with the port when present', () => {
    expect(previewLabel('preview:5173')).toBe('Preview :5173')
  })
  it('falls back to a bare label when the port is unreadable', () => {
    expect(previewLabel('preview:bad')).toBe('Preview')
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
