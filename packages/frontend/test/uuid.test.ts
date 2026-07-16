import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from '#lib/uuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUUID', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('delegates to native crypto.randomUUID in a secure context', () => {
    const native = vi.fn(() => '11111111-1111-4111-8111-111111111111')
    vi.stubGlobal('crypto', {
      randomUUID: native,
      getRandomValues: () => { throw new Error('getRandomValues must not be used when native exists') },
    })
    expect(randomUUID()).toBe('11111111-1111-4111-8111-111111111111')
    expect(native).toHaveBeenCalledOnce()
  })

  it('falls back to getRandomValues on an insecure origin (no randomUUID)', () => {
    // Deterministic bytes 0,1,2,…,15 so the formatting is checkable.
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i
      return arr
    })
    vi.stubGlobal('crypto', { getRandomValues })

    const id = randomUUID()
    expect(id).toMatch(UUID_V4)
    // byte 6 (0x06) → version nibble forced to 4: 0x06 & 0x0f | 0x40 = 0x46
    expect(id.slice(14, 16)).toBe('46')
    // byte 8 (0x08) → variant nibble forced to 10xx: 0x08 & 0x3f | 0x80 = 0x88
    expect(id.slice(19, 21)).toBe('88')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })

  it('produces distinct ids on successive calls', () => {
    let seed = 0
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (seed + i) & 0xff
        seed += 1
        return arr
      },
    })
    expect(randomUUID()).not.toBe(randomUUID())
  })
})
