import { describe, it, expect } from 'vitest'
import { parseNulEnv } from '@/electron/shell-env'

describe('parseNulEnv', () => {
  it('parses a NUL-delimited env dump', () => {
    expect(parseNulEnv('PATH=/usr/bin\0HOME=/home/me\0'))
      .toEqual({ PATH: '/usr/bin', HOME: '/home/me' })
  })
  it('keeps values containing = and newlines', () => {
    expect(parseNulEnv('A=x=y\0B=line1\nline2\0'))
      .toEqual({ A: 'x=y', B: 'line1\nline2' })
  })
  it('skips blank and keyless entries', () => {
    expect(parseNulEnv('\0=novalue\0PATH=/bin\0')).toEqual({ PATH: '/bin' })
  })
  it('returns an empty record for empty input', () => {
    expect(parseNulEnv('')).toEqual({})
  })
})
