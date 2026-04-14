import { describe, it, expect } from 'vitest'
import { extract } from 'tar-stream'
import { Readable } from 'node:stream'
import { packTar } from '@/lib/container/image-builder'

function extractEntries(buf: Buffer): Promise<{ name: string; content: string }[]> {
  return new Promise((resolve, reject) => {
    const entries: { name: string; content: string }[] = []
    const ex = extract()
    ex.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        entries.push({ name: header.name, content: Buffer.concat(chunks).toString() })
        next()
      })
    })
    ex.on('finish', () => resolve(entries))
    ex.on('error', reject)
    Readable.from(buf).pipe(ex)
  })
}

describe('packTar', () => {
  it('creates a tar with a single entry', async () => {
    const buf = await packTar([{ name: 'hello.txt', content: 'world' }])
    const entries = await extractEntries(buf)
    expect(entries).toEqual([{ name: 'hello.txt', content: 'world' }])
  })

  it('creates a tar with multiple entries', async () => {
    const buf = await packTar([
      { name: 'a.txt', content: 'aaa' },
      { name: 'b.txt', content: 'bbb' },
    ])
    const entries = await extractEntries(buf)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ name: 'a.txt', content: 'aaa' })
    expect(entries[1]).toEqual({ name: 'b.txt', content: 'bbb' })
  })

  it('handles empty content', async () => {
    const buf = await packTar([{ name: 'empty.txt', content: '' }])
    const entries = await extractEntries(buf)
    expect(entries).toEqual([{ name: 'empty.txt', content: '' }])
  })
})
