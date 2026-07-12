import { describe, it, expect } from 'vitest'
import { isAgentsTarget, AGENTS_TARGET, formatAgentDuration } from '@/frontend/lib/agentsApi'

describe('isAgentsTarget', () => {
  it('matches only the agents target', () => {
    expect(isAgentsTarget(AGENTS_TARGET)).toBe(true)
    expect(isAgentsTarget('agents')).toBe(true)
    expect(isAgentsTarget('changes')).toBe(false)
    expect(isAgentsTarget('agent')).toBe(false)
  })
})

describe('formatAgentDuration', () => {
  it('formats sub-second-to-minutes compactly', () => {
    expect(formatAgentDuration(3400)).toBe('3.4s')
    expect(formatAgentDuration(12000)).toBe('12s')
    expect(formatAgentDuration(74000)).toBe('1m 14s')
  })
  it('is empty for invalid inputs', () => {
    expect(formatAgentDuration(-5)).toBe('')
    expect(formatAgentDuration(NaN)).toBe('')
  })
})
