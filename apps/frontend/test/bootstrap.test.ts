import { describe, it, expect, vi, afterEach } from 'vitest'
import { readBootstrapCode, postBootstrap } from '#lib/bootstrap'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('readBootstrapCode', () => {
  it('extracts the bootstrap query param', () => {
    expect(readBootstrapCode('?bootstrap=abc123')).toBe('abc123')
  })

  it('returns null when absent', () => {
    expect(readBootstrapCode('?foo=1')).toBeNull()
    expect(readBootstrapCode('')).toBeNull()
  })
})

describe('postBootstrap', () => {
  it('returns true on 204', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204 }) as unknown as typeof fetch
    expect(await postBootstrap('code')).toBe(true)
  })

  it('returns false on a non-204 (e.g. expired code → 401)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401 }) as unknown as typeof fetch
    expect(await postBootstrap('code')).toBe(false)
  })
})
