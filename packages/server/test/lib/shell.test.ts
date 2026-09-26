import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { doubleQuoted, shellEscape, shellQuote } from '#lib/shell'

const execFileAsync = promisify(execFile)

describe('shellQuote', () => {
  it('single-quotes plain tokens', () => {
    expect(shellQuote('abc')).toBe(`'abc'`)
    expect(shellQuote('a b $HOME `id` "x"')).toBe(`'a b $HOME \`id\` "x"'`)
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('round-trips through a real sh -c', async () => {
    const tricky = `a'b "c" $d \`e\` \\f`
    const { stdout } = await execFileAsync('sh', ['-c', `printf '%s' ${shellQuote(tricky)}`])
    expect(stdout).toBe(tricky)
  })
})

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

describe('doubleQuoted', () => {
  it('reaches a real sh -c as written, expanding nothing', async () => {
    const tricky = 'a "b" $HOME `id` \\c {d,e}'
    const { stdout } = await execFileAsync('sh', ['-c', `printf '%s' ${doubleQuoted(tricky)}`])
    expect(stdout).toBe(tricky)
  })

  it('refuses a single quote, which would end the launch wrapper', () => {
    expect(() => doubleQuoted("it's")).toThrow(/single quote/)
  })
})
