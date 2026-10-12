import { describe, it, expect } from 'vitest'
import { buildTrayBitmap } from '#tray-icon'

const alphaAt = (b: { data: Buffer; width: number }, x: number, y: number): number =>
  b.data[(y * b.width + x) * 4 + 3]

describe('buildTrayBitmap', () => {
  it('returns a BGRA buffer of the requested size', () => {
    const b = buildTrayBitmap(36)
    expect(b.width).toBe(36)
    expect(b.height).toBe(36)
    expect(b.data.length).toBe(36 * 36 * 4)
  })
  it('draws the head, horns and ears, with gaps around them', () => {
    const b = buildTrayBitmap(36)
    expect(alphaAt(b, 18, 18)).toBe(255) // head
    expect(alphaAt(b, 5, 5)).toBe(255) // horn
    expect(alphaAt(b, 3, 16)).toBe(255) // ear
    expect(alphaAt(b, 4, 11)).toBe(0) // between horn and ear
    expect(alphaAt(b, 18, 2)).toBe(0) // between the horns
    expect(alphaAt(b, 0, 0)).toBe(0)
    expect(alphaAt(b, 35, 35)).toBe(0)
  })
  it('keeps RGB channels zero (a template glyph)', () => {
    const b = buildTrayBitmap(36)
    const i = (18 * 36 + 18) * 4
    expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([0, 0, 0])
  })
})
