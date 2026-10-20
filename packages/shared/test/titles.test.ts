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

  // Agents write their titles, and the CLI prints them to a terminal.
  it('drops control characters, so no escape sequence survives', () => {
    expect(normalizeTitle('Fix\x1b]52;c;aGk=\x07 the\x9b31m parser\x7f')).toBe('Fix]52;c;aGk= the31m parser')
    expect(normalizeTitle('a\tb\nc')).toBe('a b c')
  })

  it('returns the empty string for a blank title (which clears the entry)', () => {
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle('   \n  ')).toBe('')
  })
})
