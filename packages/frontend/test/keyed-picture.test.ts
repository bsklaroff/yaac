import { describe, expect, it } from 'vitest'
import { keyBackground } from '#ui/keyedPicture'

const SIZE = 16
type Rgba = [number, number, number, number]

/* A SIZE² picture coloured by `at(x, y)`. */
function picture(at: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) px.set(at(x, y), (y * SIZE + x) * 4)
  }
  return px
}
const pixel = (px: Uint8ClampedArray, x: number, y: number): number[] => [...px.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4)]
/* A logo square in the middle, over `bg`. */
const logoOn = (bg: Rgba, logo: Rgba = [107, 200, 127, 255]) =>
  picture((x, y) => (x >= 5 && x < 11 && y >= 5 && y < 11 ? logo : bg))

describe('keyBackground', () => {
  it('keys out a solid background and keeps the logo, saying whether it was dark', () => {
    const dark = logoOn([23, 23, 26, 255])
    expect(keyBackground(dark, SIZE)).toEqual({ dark: true })
    expect(pixel(dark, 0, 0)[3]).toBe(0)
    expect(pixel(dark, 7, 7)).toEqual([107, 200, 127, 255])

    const light = logoOn([250, 250, 250, 255])
    expect(keyBackground(light, SIZE)).toEqual({ dark: false })
    expect(pixel(light, 15, 15)[3]).toBe(0)
  })

  it('fades a pixel near the background, un-mixing the background from its colour', () => {
    // 36 from black is halfway through the fade (12 to 60): half opacity,
    // with black taken back out of the colour.
    const px = logoOn([0, 0, 0, 255])
    px.set([36, 18, 0, 255], (4 * SIZE + 7) * 4)
    keyBackground(px, SIZE)
    expect(pixel(px, 7, 4)).toEqual([72, 36, 0, 128])
  })

  it('leaves a picture with no solid background as it is', () => {
    const cases = {
      'transparent corners': logoOn([0, 0, 0, 0]),
      'a gradient': picture((x, y) => [(x + y) * 8, (x + y) * 8, (x + y) * 8, 255]),
      'a split background': picture((x) => (x < SIZE / 2 ? [220, 40, 40, 255] : [40, 40, 220, 255])),
      'nearly all background': logoOn([255, 255, 255, 255], [248, 248, 248, 255]),
    }
    for (const [name, px] of Object.entries(cases)) {
      const before = [...px]
      expect(keyBackground(px, SIZE), name).toBeNull()
      expect([...px], name).toEqual(before)
    }
  })
})
