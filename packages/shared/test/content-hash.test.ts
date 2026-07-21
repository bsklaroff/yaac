import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectFileHashes, combineHashes, hashBuffer, type HashEntry } from '#content-hash'

describe('content-hash', () => {
  describe('hashBuffer', () => {
    it('produces a 64-char hex digest', () => {
      expect(hashBuffer(Buffer.from('hello'))).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is stable for the same bytes and differs for different bytes', () => {
      expect(hashBuffer(Buffer.from('hello'))).toBe(hashBuffer(Buffer.from('hello')))
      expect(hashBuffer(Buffer.from('hello'))).not.toBe(hashBuffer(Buffer.from('hello!')))
    })
  })

  describe('combineHashes', () => {
    const entries: HashEntry[] = [
      { rel: 'a', hash: 'aa' },
      { rel: 'b', hash: 'bb' },
      { rel: 'c/d', hash: 'cc' },
    ]

    it('produces a 64-char hex digest', () => {
      expect(combineHashes(entries)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is independent of entry order', () => {
      const reversed = [...entries].reverse()
      expect(combineHashes(reversed)).toBe(combineHashes(entries))
    })

    it('does not mutate the caller array', () => {
      const input = [...entries]
      combineHashes(input)
      expect(input).toEqual(entries)
    })

    it('changes when a content hash changes', () => {
      const changed = [{ rel: 'a', hash: 'aa' }, { rel: 'b', hash: 'XX' }, { rel: 'c/d', hash: 'cc' }]
      expect(combineHashes(changed)).not.toBe(combineHashes(entries))
    })

    it('changes when a rel path changes', () => {
      const renamed = [{ rel: 'a', hash: 'aa' }, { rel: 'B', hash: 'bb' }, { rel: 'c/d', hash: 'cc' }]
      expect(combineHashes(renamed)).not.toBe(combineHashes(entries))
    })

    it('changes when an entry is added or removed', () => {
      const withExtra = [...entries, { rel: 'e', hash: 'ee' }]
      expect(combineHashes(withExtra)).not.toBe(combineHashes(entries))
      expect(combineHashes(entries.slice(1))).not.toBe(combineHashes(entries))
    })

    it('disambiguates rel/hash boundaries via the NUL delimiter', () => {
      // Without a delimiter these two sets would concatenate to the same
      // byte stream ("abc"); the NUL separators keep them distinct.
      const a = combineHashes([{ rel: 'a', hash: 'bc' }])
      const b = combineHashes([{ rel: 'ab', hash: 'c' }])
      expect(a).not.toBe(b)
    })

    it('hashes an empty set to a fixed digest', () => {
      expect(combineHashes([])).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('collectFileHashes', () => {
    let dir: string

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-content-hash-test-'))
    })

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('collects every file recursively with POSIX rel paths', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'A')
      await fs.mkdir(path.join(dir, 'sub'))
      await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'B')

      const entries = await collectFileHashes(dir)
      const rels = entries.map((e) => e.rel).sort()
      expect(rels).toEqual(['a.txt', 'sub/b.txt'])
      expect(entries.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true)
    })

    it('skips directories named in skipDirs at any depth', async () => {
      await fs.writeFile(path.join(dir, 'keep.txt'), 'keep')
      await fs.mkdir(path.join(dir, 'node_modules'))
      await fs.writeFile(path.join(dir, 'node_modules', 'dep.js'), 'dep')
      await fs.mkdir(path.join(dir, 'sub', 'dist'), { recursive: true })
      await fs.writeFile(path.join(dir, 'sub', 'dist', 'out.js'), 'out')

      const entries = await collectFileHashes(dir, { skipDirs: new Set(['node_modules', 'dist']) })
      expect(entries.map((e) => e.rel).sort()).toEqual(['keep.txt'])
    })

    it('prefixes rel paths when a prefix is given', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'A')
      const entries = await collectFileHashes(dir, { prefix: 'frontend' })
      expect(entries.map((e) => e.rel)).toEqual(['frontend/a.txt'])
    })

    it('returns an empty array for a missing root', async () => {
      expect(await collectFileHashes(path.join(dir, 'does-not-exist'))).toEqual([])
    })

    it('feeds combineHashes a digest that tracks file content', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'v1')
      const before = combineHashes(await collectFileHashes(dir))
      await fs.writeFile(path.join(dir, 'a.txt'), 'v2')
      const after = combineHashes(await collectFileHashes(dir))
      expect(after).not.toBe(before)
    })
  })
})
