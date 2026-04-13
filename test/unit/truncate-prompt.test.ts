import { describe, it, expect } from 'vitest'
import { truncatePrompt } from '@/commands/session-list'

describe('truncatePrompt', () => {
  it('returns empty string for undefined', () => {
    expect(truncatePrompt(undefined, 40)).toBe('')
  })

  it('returns full text when within width', () => {
    expect(truncatePrompt('fix the bug', 40)).toBe('fix the bug')
  })

  it('truncates with ellipsis when exceeding width', () => {
    const long = 'a'.repeat(50)
    const result = truncatePrompt(long, 20)
    expect(result).toHaveLength(20)
    expect(result.endsWith('\u2026')).toBe(true)
  })

  it('collapses newlines and extra whitespace', () => {
    expect(truncatePrompt('fix\nthe\n  bug', 40)).toBe('fix the bug')
  })

  it('trims leading and trailing whitespace', () => {
    expect(truncatePrompt('  hello  ', 40)).toBe('hello')
  })

  it('returns exact width text without truncation', () => {
    const exact = 'a'.repeat(20)
    expect(truncatePrompt(exact, 20)).toBe(exact)
  })
})
