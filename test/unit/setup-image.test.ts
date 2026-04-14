import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileHash } from '@/lib/container/image-builder'

describe('fileHash', () => {
  it('returns a 16-character hex hash of file contents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-hash-test-'))
    const tmpFile = path.join(tmpDir, 'test.txt')
    await fs.writeFile(tmpFile, 'hello world')

    const hash = await fileHash(tmpFile)

    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns different hashes for different content', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-hash-test-'))
    const file1 = path.join(tmpDir, 'a.txt')
    const file2 = path.join(tmpDir, 'b.txt')
    await fs.writeFile(file1, 'content A')
    await fs.writeFile(file2, 'content B')

    const hash1 = await fileHash(file1)
    const hash2 = await fileHash(file2)

    expect(hash1).not.toBe(hash2)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the same hash for identical content', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-hash-test-'))
    const file1 = path.join(tmpDir, 'a.txt')
    const file2 = path.join(tmpDir, 'b.txt')
    await fs.writeFile(file1, 'same content')
    await fs.writeFile(file2, 'same content')

    const hash1 = await fileHash(file1)
    const hash2 = await fileHash(file2)

    expect(hash1).toBe(hash2)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})
