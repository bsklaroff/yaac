import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { shellQuote } from '#platform/shell'

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
