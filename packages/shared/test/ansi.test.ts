import { describe, it, expect } from 'vitest'
import { stripAnsi, stripControlChars } from '#ansi'

describe('stripAnsi', () => {
  it('drops colors, cursor controls, and OSC sequences', () => {
    expect(stripAnsi('\x1b[94mhttps://x\x1b[0m\x1b[?25l\x1b]0;title\x07 done')).toBe('https://x done')
  })

  it('drops control characters but keeps newlines', () => {
    expect(stripAnsi('a\rb\nc\x07d')).toBe('ab\ncd')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('STEP 1/3: FROM ubuntu')).toBe('STEP 1/3: FROM ubuntu')
  })
})

describe('stripControlChars', () => {
  it('drops C0, DEL and C1 but keeps newlines, tabs and the rest of an escape', () => {
    expect(stripControlChars('a\x1b[201~b\r\n\tc\x07\x7f\u009bd ü')).toBe('a[201~b\n\tcd ü')
  })
})
