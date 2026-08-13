import { describe, it, expect } from 'vitest'
import { normalizeTool } from '#types'

describe('normalizeTool', () => {
  it('returns claude when the raw value is undefined', () => {
    expect(normalizeTool(undefined)).toBe('claude')
  })

  it('returns claude when the raw value is claude', () => {
    expect(normalizeTool('claude')).toBe('claude')
  })

  it('returns codex when the raw value is codex', () => {
    expect(normalizeTool('codex')).toBe('codex')
  })

  it('returns opencode when the raw value is opencode', () => {
    expect(normalizeTool('opencode')).toBe('opencode')
  })

  it('returns pi when the raw value is pi', () => {
    expect(normalizeTool('pi')).toBe('pi')
  })

  it('returns claude for an empty string', () => {
    expect(normalizeTool('')).toBe('claude')
  })

  it('returns claude for unknown tool values', () => {
    // A workspace stamped with a tool this build does not know still has to
    // render and be exec'd into, so the resolved value is always runnable.
    expect(normalizeTool('unknown')).toBe('claude')
  })
})
