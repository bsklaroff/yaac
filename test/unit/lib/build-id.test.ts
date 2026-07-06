import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { computeBuildId, readBuildId, writeBuildId, buildIdPath } from '@/shared/build-id'

describe('build-id', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-build-id-test-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    delete process.env.YAAC_BUILD_ID
  })

  describe('computeBuildId', () => {
    it('produces a stable 64-char hex digest', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
      const id = await computeBuildId(dir)
      expect(id).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is deterministic across calls', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
      await fs.mkdir(path.join(dir, 'sub'))
      await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'world')
      const first = await computeBuildId(dir)
      const second = await computeBuildId(dir)
      expect(first).toBe(second)
    })

    it('changes when a file content changes', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
      const before = await computeBuildId(dir)
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello!')
      const after = await computeBuildId(dir)
      expect(before).not.toBe(after)
    })

    it('changes when a file is added', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
      const before = await computeBuildId(dir)
      await fs.writeFile(path.join(dir, 'b.txt'), 'new')
      const after = await computeBuildId(dir)
      expect(before).not.toBe(after)
    })

    it('excludes the .build-id file itself so writing the hash is idempotent', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
      const before = await computeBuildId(dir)
      await writeBuildId(dir, before)
      const after = await computeBuildId(dir)
      expect(before).toBe(after)
    })

    it('ignores the runtime-data dirs (dockerfiles/, k8s/) so edits there do not bounce the daemon', async () => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'hello')
      const before = await computeBuildId(dir)

      await fs.mkdir(path.join(dir, 'dockerfiles'))
      await fs.writeFile(path.join(dir, 'dockerfiles', 'Dockerfile.tools'), 'RUN echo v2')
      await fs.mkdir(path.join(dir, 'k8s', 'proxy'), { recursive: true })
      await fs.writeFile(path.join(dir, 'k8s', 'proxy', 'server.js'), 'edited')
      const after = await computeBuildId(dir)

      expect(after).toBe(before)
    })

    it('still hashes nested dirs that merely share the runtime-data names', async () => {
      await fs.mkdir(path.join(dir, 'frontend', 'k8s'), { recursive: true })
      await fs.writeFile(path.join(dir, 'frontend', 'k8s', 'chunk.js'), 'v1')
      const before = await computeBuildId(dir)
      await fs.writeFile(path.join(dir, 'frontend', 'k8s', 'chunk.js'), 'v2')
      const after = await computeBuildId(dir)
      expect(after).not.toBe(before)
    })

    it('sorts entries so filesystem readdir order does not affect the hash', async () => {
      // Create files in a reversed order; if the implementation didn't
      // sort, the hash would change depending on readdir order.
      await fs.writeFile(path.join(dir, 'z.txt'), '1')
      await fs.writeFile(path.join(dir, 'a.txt'), '2')
      const id1 = await computeBuildId(dir)

      const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-build-id-test2-'))
      try {
        await fs.writeFile(path.join(dir2, 'a.txt'), '2')
        await fs.writeFile(path.join(dir2, 'z.txt'), '1')
        const id2 = await computeBuildId(dir2)
        expect(id1).toBe(id2)
      } finally {
        await fs.rm(dir2, { recursive: true, force: true })
      }
    })
  })

  describe('buildIdPath', () => {
    it('resolves to <rootDir>/.build-id', () => {
      expect(buildIdPath('/foo/dist')).toBe(path.join('/foo/dist', '.build-id'))
    })
  })

  describe('writeBuildId', () => {
    it('writes the id followed by a newline', async () => {
      await writeBuildId(dir, 'cafebabe')
      expect(await fs.readFile(buildIdPath(dir), 'utf8')).toBe('cafebabe\n')
    })
  })

  describe('readBuildId', () => {
    it('returns the file contents, trimmed', async () => {
      await fs.writeFile(buildIdPath(dir), 'deadbeef\n')
      expect(await readBuildId(dir)).toBe('deadbeef')
    })

    it('throws a clear error when the file is missing', async () => {
      await expect(readBuildId(dir)).rejects.toThrow(/broken install/)
    })

    it('throws when the file is empty', async () => {
      await fs.writeFile(buildIdPath(dir), '\n')
      await expect(readBuildId(dir)).rejects.toThrow(/empty/)
    })

    it('honors YAAC_BUILD_ID env override', async () => {
      process.env.YAAC_BUILD_ID = 'from-env'
      expect(await readBuildId(dir)).toBe('from-env')
    })
  })
})
