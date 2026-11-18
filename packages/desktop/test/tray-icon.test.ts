import { describe, it, expect } from 'vitest'
import { buildBadgeBitmap, buildTileBitmap, buildTrayBitmap } from '#tray-icon'

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
  it('draws white for a dark taskbar, keeping transparent pixels black', () => {
    const b = buildTrayBitmap(36, 'white')
    expect([...b.data.subarray((27 * 36 + 15) * 4, (27 * 36 + 15) * 4 + 4)]).toEqual([255, 255, 255, 255])
    expect([...b.data.subarray(0, 4)]).toEqual([0, 0, 0, 0])
  })
})

describe('buildTileBitmap', () => {
  const rgbaAt = (b: { data: Buffer; width: number }, x: number, y: number): number[] => {
    const at = (y * b.width + x) * 4
    return [b.data[at + 2], b.data[at + 1], b.data[at], b.data[at + 3]]
  }
  it('is an opaque near-black tile with rounded, clear corners', () => {
    const b = buildTileBitmap(36)
    expect(rgbaAt(b, 18, 1)).toEqual([0x17, 0x17, 0x1a, 255]) // between the arms, on the tile
    for (const [x, y] of [[0, 0], [35, 0], [0, 35], [35, 35]]) expect(alphaAt(b, x, y)).toBe(0)
  })
  it('draws the mark in the icon\'s orange inside it', () => {
    const b = buildTileBitmap(36)
    const orange = [...Array(36 * 36).keys()].filter((i) => rgbaAt(b, i % 36, Math.floor(i / 36)).join() === [0xf2, 0x98, 0x52, 255].join())
    expect(orange.length).toBeGreaterThan(50)
  })
})

describe('buildBadgeBitmap', () => {
  it('is a red dot, opaque at the center and clear in the corners', () => {
    const b = buildBadgeBitmap(16)
    expect([...b.data.subarray((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)]).toEqual([0x4d, 0x48, 0xe5, 255])
    for (const [x, y] of [[0, 0], [15, 0], [0, 15], [15, 15]]) expect(alphaAt(b, x, y)).toBe(0)
  })
})
