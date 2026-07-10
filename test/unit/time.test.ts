import { describe, it, expect } from 'vitest'
import { formatUtcTimestamp } from '@yaac/shared/time'

describe('formatUtcTimestamp', () => {
  it("formats epoch ms as 'YYYY-MM-DD HH:MM:SS' UTC, dropping sub-second precision", () => {
    expect(formatUtcTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5, 678))).toBe('2026-01-02 03:04:05')
  })

  it('formats the epoch itself', () => {
    expect(formatUtcTimestamp(0)).toBe('1970-01-01 00:00:00')
  })
})
