import { describe, it, expect } from 'vitest'
import { timingSafeStrEqual } from 'yaac-proxy-sidecar/secure-compare'

/**
 * Tests for the constant-time bearer compare backing the proxy control-API
 * auth check (`checkAuth` in proxy.ts). We assert the boolean contract — the
 * timing property itself isn't observable from a unit test — including that a
 * length mismatch returns false rather than throwing out of `timingSafeEqual`.
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
