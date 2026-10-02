import { describe, it, expect } from 'vitest'
import { timingSafeStrEqual } from 'yaac-proxy-sidecar/secure-compare'

/**
 * Tests for the constant-time compare behind the stream relay's auth line. Only the boolean result is testable, including that a length
 * mismatch returns false instead of throwing from `timingSafeEqual`.
 */
describe('timingSafeStrEqual', () => {
  it('is true only for byte-identical strings', () => {
    expect(timingSafeStrEqual('secret', 'secret')).toBe(true)
    expect(timingSafeStrEqual('secret', 'secreT')).toBe(false)
  })

  it('returns false for length mismatches without throwing', () => {
    expect(timingSafeStrEqual('short', 'longer-value')).toBe(false)
    expect(timingSafeStrEqual('', 'x')).toBe(false)
  })

  it('treats two empty strings as equal', () => {
    expect(timingSafeStrEqual('', '')).toBe(true)
  })

  it('matches a realistic bearer header only on an exact secret', () => {
    const secret = 'a'.repeat(64)
    expect(timingSafeStrEqual(`Bearer ${secret}`, `Bearer ${secret}`)).toBe(true)
    // Same length, differs in the final byte — must not early-out to true.
    expect(timingSafeStrEqual(`Bearer ${secret}`, `Bearer ${'a'.repeat(63)}b`)).toBe(false)
  })
})
