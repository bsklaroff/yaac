import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  MAX_TEXT_FILE_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  resolveBuildFilePath,
  listBuildFiles,
  readBuildFile,
  writeBuildFile,
  deleteBuildFile,
} from '#lib/project/build-files'

describe('build files', () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-build-files-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  describe('resolveBuildFilePath', () => {
    it('resolves nested relative paths under the root', () => {
      expect(resolveBuildFilePath(root, 'nvim/init.lua')).toBe(path.join(root, 'nvim', 'init.lua'))
      expect(resolveBuildFilePath(root, './a//b')).toBe(path.join(root, 'a', 'b'))
      expect(resolveBuildFilePath(root, 'dir/')).toBe(path.join(root, 'dir'))
    })

    it.each([
      '',
      ' padded ',
      '/etc/passwd',
      '..',
      '../outside',
      'a/../../b',
      'a/..',
      '.',
      'a\\b',
      'a\0b',
    ])('rejects %j', (rel) => {
      expect(() => resolveBuildFilePath(root, rel)).toThrow()
    })

    it('rejects the reserved Dockerfile names at the root only', () => {
      expect(() => resolveBuildFilePath(root, 'Dockerfile.yaac')).toThrow(/Dockerfile editor/)
      expect(() => resolveBuildFilePath(root, './Dockerfile.user')).toThrow(/Dockerfile editor/)
      expect(resolveBuildFilePath(root, 'sub/Dockerfile.user')).toBe(path.join(root, 'sub', 'Dockerfile.user'))
    })
  })

  describe('listBuildFiles', () => {
    it('returns [] for a missing root', async () => {
      expect(await listBuildFiles(path.join(root, 'nope'))).toEqual([])
    })

    it('lists nested files sorted, hiding the root Dockerfile', async () => {
      await fs.mkdir(path.join(root, 'nvim'), { recursive: true })
      await fs.writeFile(path.join(root, 'Dockerfile.user'), 'ARG BASE_IMAGE\n')
      await fs.writeFile(path.join(root, 'nvim', 'init.lua'), 'print(1)\n')
      await fs.writeFile(path.join(root, 'a.txt'), 'hello')
      await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2]))

      const files = await listBuildFiles(root)
      expect(files).toEqual([
        { path: 'a.txt', size: 5, binary: false },
        { path: 'blob.bin', size: 3, binary: true },
        { path: 'nvim/init.lua', size: 9, binary: false },
      ])
    })
  })

  describe('readBuildFile', () => {
    it('returns text content for an editable file', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), 'hello')
      expect(await readBuildFile(root, 'a.txt'))
        .toEqual({ path: 'a.txt', size: 5, binary: false, content: 'hello' })
    })

    it('returns null content for binary and over-cap files', async () => {
      await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2]))
      await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_TEXT_FILE_BYTES + 1))
      expect((await readBuildFile(root, 'blob.bin')).content).toBeNull()
      const big = await readBuildFile(root, 'big.txt')
      expect(big.content).toBeNull()
      expect(big.binary).toBe(false)
    })

    it('throws NOT_FOUND for a missing file and VALIDATION for a folder', async () => {
      await fs.mkdir(path.join(root, 'dir'))
      await expect(readBuildFile(root, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(readBuildFile(root, 'dir')).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('writeBuildFile', () => {
    it('creates parent folders and reports the entry', async () => {
      const entry = await writeBuildFile(root, 'nvim/lua/opts.lua', Buffer.from('return {}\n'))
      expect(entry).toEqual({ path: 'nvim/lua/opts.lua', size: 10, binary: false })
      expect(await fs.readFile(path.join(root, 'nvim/lua/opts.lua'), 'utf8')).toBe('return {}\n')
    })

    it('creates a missing root (uploads may precede the Dockerfile)', async () => {
      const fresh = path.join(root, 'not-yet-created')
      await writeBuildFile(fresh, 'a.txt', Buffer.from('hi'))
      expect(await fs.readFile(path.join(fresh, 'a.txt'), 'utf8')).toBe('hi')
    })

    it('overwrites an existing file', async () => {
      await writeBuildFile(root, 'a.txt', Buffer.from('one'))
      await writeBuildFile(root, 'a.txt', Buffer.from('two'))
      expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('two')
    })

    it('rejects a file over the per-file cap', async () => {
      const big = Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1)
      await expect(writeBuildFile(root, 'big', big)).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects a path crossing an existing file', async () => {
      await writeBuildFile(root, 'a', Buffer.from('file'))
      await expect(writeBuildFile(root, 'a/b', Buffer.from('x')))
        .rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('deleteBuildFile', () => {
    it('deletes a file and a folder recursively', async () => {
      await writeBuildFile(root, 'a.txt', Buffer.from('x'))
      await writeBuildFile(root, 'nvim/init.lua', Buffer.from('x'))
      await deleteBuildFile(root, 'a.txt')
      await deleteBuildFile(root, 'nvim')
      expect(await listBuildFiles(root)).toEqual([])
    })

    it('throws NOT_FOUND for a missing path', async () => {
      await expect(deleteBuildFile(root, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })
})
