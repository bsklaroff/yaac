import { describe, it, expect } from 'vitest'
import { backgroundColorFor } from '@/electron/theme-bg'

describe('backgroundColorFor', () => {
  it('is the dark shell when the OS is dark', () => {
    expect(backgroundColorFor(true)).toBe('#0b0b0d')
  })

  it('is the warm paper shell when the OS is light', () => {
    expect(backgroundColorFor(false)).toBe('#efeee9')
  })
})
