import { describe, it, expect } from 'vitest'
import { getToolFromContainer } from '@/lib/session/status'

describe('getToolFromContainer', () => {
  it('returns claude when no yaac.tool label exists', () => {
    expect(getToolFromContainer({ Labels: { 'yaac.project': 'test' } })).toBe('claude')
  })

  it('returns claude when yaac.tool is claude', () => {
    expect(getToolFromContainer({ Labels: { 'yaac.tool': 'claude' } })).toBe('claude')
  })

  it('returns codex when yaac.tool is codex', () => {
    expect(getToolFromContainer({ Labels: { 'yaac.tool': 'codex' } })).toBe('codex')
  })

  it('returns claude when Labels is undefined', () => {
    expect(getToolFromContainer({})).toBe('claude')
  })

  it('returns claude for unknown tool values', () => {
    expect(getToolFromContainer({ Labels: { 'yaac.tool': 'unknown' } })).toBe('claude')
  })
})
