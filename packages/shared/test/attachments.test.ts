import { describe, it, expect } from 'vitest'
import { sniffImage } from '#attachments'

describe('sniffImage', () => {
  it('names each accepted image type by its magic bytes, whatever it claims to be', () => {
    const bytes = (s: string): Uint8Array => Buffer.from(s, 'latin1')
    expect(sniffImage(bytes('\x89PNG\r\n\x1a\n'))).toEqual({ mimeType: 'image/png', ext: 'png' })
    expect(sniffImage(bytes('\xff\xd8\xff\xe0'))).toEqual({ mimeType: 'image/jpeg', ext: 'jpg' })
    expect(sniffImage(bytes('GIF89a'))).toEqual({ mimeType: 'image/gif', ext: 'gif' })
    expect(sniffImage(bytes('RIFF\0\0\0\0WEBPVP8 '))).toEqual({ mimeType: 'image/webp', ext: 'webp' })
    // A RIFF that is not WebP (a WAV), an SVG, and nothing at all.
    expect(sniffImage(bytes('RIFF\0\0\0\0WAVEfmt '))).toBeUndefined()
    expect(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(sniffImage(new Uint8Array())).toBeUndefined()
  })
})
