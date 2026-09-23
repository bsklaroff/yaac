import { describe, it, expect } from 'vitest'
import { isBinaryContent } from '#lib/text-file'

describe('isBinaryContent', () => {
  it('passes UTF-8 text, and fails a NUL or invalid UTF-8', () => {
    expect(isBinaryContent(Buffer.from('héllo wörld\n'))).toBe(false)
    expect(isBinaryContent(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
    expect(isBinaryContent(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true)
  })

  it('looks for a NUL only in the first 8,000 bytes', () => {
    const late = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])])
    expect(isBinaryContent(late)).toBe(false)
  })

  it('forgives a character cut off at the end of a partial head', () => {
    const cut = Buffer.from('é').subarray(0, 1)
    expect(isBinaryContent(cut, true)).toBe(false)
    expect(isBinaryContent(cut)).toBe(true)
  })
})
