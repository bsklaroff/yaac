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
  it('draws the four strokes, with gaps around them', () => {
    const b = buildTrayBitmap(36)
    expect(alphaAt(b, 15, 27)).toBe(255) // inner left stroke
    expect(alphaAt(b, 20, 27)).toBe(255) // inner right stroke
    expect(alphaAt(b, 9, 26)).toBe(255) // outer left stroke
    expect(alphaAt(b, 26, 26)).toBe(255) // outer right stroke
    expect(alphaAt(b, 15, 33)).toBe(255) // the inner strokes run longer
    expect(alphaAt(b, 9, 33)).toBe(0)
    for (const x of [11, 12, 17, 18, 23, 24]) expect(alphaAt(b, x, 22)).toBe(0) // between the stems
    expect(alphaAt(b, 17, 3)).toBe(0) // between the arms
    for (let i = 0; i < 36; i++) { // fits inside the canvas, edges clear
      for (const [x, y] of [[i, 0], [i, 35], [0, i], [35, i]]) expect(alphaAt(b, x, y)).toBe(0)
    }
  })
  it('keeps RGB channels zero (a template glyph)', () => {
    const b = buildTrayBitmap(36)
    expect(b.data.some((v, i) => i % 4 !== 3 && v !== 0)).toBe(false)
  })
})
