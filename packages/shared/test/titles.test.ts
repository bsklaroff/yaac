import { describe, it, expect } from 'vitest'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'

describe('normalizeTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTitle('  Fix   the \n\t parser  bug ')).toBe('Fix the parser bug')
  })

  it('caps the length, keeping the leading words', () => {
    const normalized = normalizeTitle('w'.repeat(MAX_TITLE_LENGTH + 200))
    expect(normalized).toBe('w'.repeat(MAX_TITLE_LENGTH))
  })

  it('returns the empty string for a blank title (which clears the entry)', () => {
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle('   \n  ')).toBe('')
  })
})
