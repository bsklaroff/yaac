import { describe, it, expect } from 'vitest'
import { terminalTheme } from '#lib/terminalTheme'

describe('terminalTheme', () => {
  it('is the dark palette for dark', () => {
    const t = terminalTheme('dark')
    expect(t.background).toBe('#0b0b0d')
    expect(t.foreground).toBe('#e7e7ea')
  })

  it('is a light palette for light, with light-tuned ANSI colors', () => {
    const t = terminalTheme('light')
    expect(t.background).toBe('#e2e1dc')
    expect(t.foreground).toBe('#1a1918')
    // A full ANSI set is supplied (the dark defaults wash out on light).
    expect(t.red).toBeTruthy()
    expect(t.brightWhite).toBe('#24292f')
  })
})
