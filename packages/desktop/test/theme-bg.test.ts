import { describe, it, expect } from 'vitest'
import { backgroundColorFor } from '#theme-bg'

describe('backgroundColorFor', () => {
  it('mirrors --color-shell per theme (the html/body background)', () => {
    expect(backgroundColorFor(true)).toBe('#0f0f12')
    expect(backgroundColorFor(false)).toBe('#fcfcfb')
  })
})
