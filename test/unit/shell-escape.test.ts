import { describe, it, expect } from 'vitest'
import { shellEscape } from '@/commands/session-create'

describe('shellEscape', () => {
  it('returns simple strings unchanged', () => {
    expect(shellEscape('hello world')).toBe('hello world')
  })

  it('escapes single quotes', () => {
    expect(shellEscape("it's a test")).toBe("it'\\''s a test")
  })

  it('escapes multiple single quotes', () => {
    expect(shellEscape("don't can't won't")).toBe("don'\\''t can'\\''t won'\\''t")
  })

  it('leaves double quotes and other chars alone', () => {
    expect(shellEscape('say "hello" & goodbye')).toBe('say "hello" & goodbye')
  })

  it('handles empty string', () => {
    expect(shellEscape('')).toBe('')
  })
})
