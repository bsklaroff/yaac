import { describe, it, expect } from 'vitest'
import { normalizeTool } from '@yaac/server/lib/session/status'

describe('normalizeTool', () => {
  it('returns claude when the raw label is undefined', () => {
    expect(normalizeTool(undefined)).toBe('claude')
  })

  it('returns claude when the raw label is claude', () => {
    expect(normalizeTool('claude')).toBe('claude')
  })

  it('returns codex when the raw label is codex', () => {
    expect(normalizeTool('codex')).toBe('codex')
  })

  it('returns opencode when the raw label is opencode', () => {
    expect(normalizeTool('opencode')).toBe('opencode')
  })

  it('returns claude for an empty string', () => {
    expect(normalizeTool('')).toBe('claude')
  })

  it('returns claude for unknown tool values', () => {
    expect(normalizeTool('unknown')).toBe('claude')
  })
})
