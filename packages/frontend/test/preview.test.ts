import { describe, it, expect } from 'vitest'
import {
  isPreviewTarget,
  previewLabel,
  previewTarget,
  previewTargetPort,
  normalizePreviewNav,
  shareablePreviewUrl,
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
  it('labels with the workspace port, bare with no port', () => {
    expect(previewLabel({ containerPort: 5173, hostPort: 5174 })).toBe('Preview :5173')
    expect(previewLabel(5173)).toBe('Preview :5173')
    expect(previewLabel(undefined)).toBe('Preview')
  })
})

describe('normalizePreviewNav', () => {
  const HOME = 'http://5173.ab12cd34.localhost:8787/'
  it('uses a full http(s) url as-is', () => {
    expect(normalizePreviewNav('https://example.com/x', HOME)).toBe('https://example.com/x')
    expect(normalizePreviewNav('http://localhost:3000/', HOME)).toBe('http://localhost:3000/')
  })
  it('treats other input as a path under the preview\'s own url', () => {
    expect(normalizePreviewNav('/dashboard', HOME)).toBe(`${HOME}dashboard`)
    expect(normalizePreviewNav('settings', HOME)).toBe(`${HOME}settings`)
  })
  it('returns null when empty or when a path has no preview to go under', () => {
    expect(normalizePreviewNav('   ', HOME)).toBeNull()
    expect(normalizePreviewNav('/x', undefined)).toBeNull()
  })
})

describe('shareablePreviewUrl', () => {
  const ID = 'a528bd7a-0000-4000-8000-000000000000'

  it('turns a loopback address into the port\'s workspace hostname, keeping path, query and fragment', () => {
    expect(shareablePreviewUrl('http://localhost:3000/a/b?c=1#d', ID, 8786))
      .toBe('http://3000.a528bd7a.localhost:8786/a/b?c=1#d')
    expect(shareablePreviewUrl('http://127.0.0.1/', ID, 8787)).toBe('http://80.a528bd7a.localhost:8787/')
    expect(shareablePreviewUrl('http://[::1]:5173/', ID, 8787)).toBe('http://5173.a528bd7a.localhost:8787/')
  })

  it('leaves anything else alone, and everything when nothing routes the names', () => {
    for (const url of ['https://localhost:3000/', 'http://app.localhost:3000/', 'https://example.com/', 'not a url']) {
      expect(shareablePreviewUrl(url, ID, 8786)).toBe(url)
    }
    expect(shareablePreviewUrl('http://localhost:3000/', ID, null)).toBe('http://localhost:3000/')
  })
})
