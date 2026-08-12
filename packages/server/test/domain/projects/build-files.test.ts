import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { deleteBuildFile, listBuildFiles, readBuildFile, renameBuildFile, writeBuildFile } from '#domain/projects'
// Bounds the cases below sit either side of. Not under test here.
import { MAX_TEXT_FILE_BYTES, MAX_UPLOAD_FILE_BYTES } from '#domain/projects/build-files'
import { BUILDER_CONTEXT_MAX_BYTES } from '#lib/build-context'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-build-files-'))
})
afterEach(async () => {
  await fs.chmod(root, 0o700).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})

/** A file whose reported size is `bytes` but which occupies no disk — lets a
 *  case stand a build dir up against the 512MB context cap for free. */
async function sparseFile(rel: string, bytes: number): Promise<void> {
  const fh = await fs.open(path.join(root, rel), 'w')
  try {
    await fh.truncate(bytes)
  } finally {
    await fh.close()
  }
}

describe('listBuildFiles', () => {
  it('lists nested files sorted, with sizes and a binary flag, hiding the root Dockerfile', async () => {
    await fs.mkdir(path.join(root, 'nvim'), { recursive: true })
    await fs.writeFile(path.join(root, 'Dockerfile.user'), 'ARG BASE_IMAGE\n')
    await fs.writeFile(path.join(root, 'Dockerfile.yaac'), 'FROM ubuntu\n')
    await fs.writeFile(path.join(root, 'nvim', 'init.lua'), 'print(1)\n')
    await fs.writeFile(path.join(root, 'a.txt'), 'hello')
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2]))

    expect(await listBuildFiles(root)).toEqual([
      { path: 'a.txt', size: 5, binary: false },
      { path: 'blob.bin', size: 3, binary: true },
      { path: 'nvim/init.lua', size: 9, binary: false },
    ])
  })

  it('returns [] for a missing root — a build dir need not exist yet', async () => {
    expect(await listBuildFiles(path.join(root, 'nope'))).toEqual([])
  })

  it('surfaces a root that is not a directory rather than reporting it empty', async () => {
    const notADir = path.join(root, 'a.txt')
    await fs.writeFile(notADir, 'hello')
    await expect(listBuildFiles(notADir)).rejects.toMatchObject({ code: 'ENOTDIR' })
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

  it('refuses to read outside the build dir', async () => {
    await expect(readBuildFile(root, '../outside')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('writeBuildFile', () => {
  it('creates parent folders, normalizes the path, and reports the entry', async () => {
    expect(await writeBuildFile(root, 'nvim/lua/opts.lua', Buffer.from('return {}\n')))
      .toEqual({ path: 'nvim/lua/opts.lua', size: 10, binary: false })
    expect(await fs.readFile(path.join(root, 'nvim/lua/opts.lua'), 'utf8')).toBe('return {}\n')

    // `.` segments and doubled slashes collapse; a trailing slash is dropped.
    await writeBuildFile(root, './a//b', Buffer.from('x'))
    await writeBuildFile(root, 'dir/', Buffer.from([0, 1]))
    expect((await listBuildFiles(root)).map((f) => f.path))
      .toEqual(['a/b', 'dir', 'nvim/lua/opts.lua'])
    expect(await writeBuildFile(root, 'dir/', Buffer.from([0, 1])))
      .toEqual({ path: 'dir', size: 2, binary: true })
  })

  it('creates a missing root (uploads may precede the Dockerfile) and overwrites in place', async () => {
    const fresh = path.join(root, 'not-yet-created')
    await writeBuildFile(fresh, 'a.txt', Buffer.from('one'))
    await writeBuildFile(fresh, 'a.txt', Buffer.from('two'))
    expect(await fs.readFile(path.join(fresh, 'a.txt'), 'utf8')).toBe('two')
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
  ])('refuses to write %j', async (rel) => {
    await expect(writeBuildFile(root, rel, Buffer.from('x')))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses the reserved Dockerfile names at the root only', async () => {
    await expect(writeBuildFile(root, 'Dockerfile.yaac', Buffer.from('x')))
      .rejects.toThrow(/Dockerfile editor/)
    await expect(writeBuildFile(root, './Dockerfile.user', Buffer.from('x')))
      .rejects.toThrow(/Dockerfile editor/)
    // Nested copies are ordinary support files.
    await writeBuildFile(root, 'sub/Dockerfile.user', Buffer.from('x'))
    expect((await listBuildFiles(root)).map((f) => f.path)).toEqual(['sub/Dockerfile.user'])
  })

  it('rejects a file over the per-file cap', async () => {
    await expect(writeBuildFile(root, 'big', Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1)))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('rejects an upload that would push the folder past the whole-context cap', async () => {
    await sparseFile('already-there', BUILDER_CONTEXT_MAX_BYTES)
    await expect(writeBuildFile(root, 'one-byte-too-many', Buffer.from('x')))
      .rejects.toThrow(/context limit/)

    // The cap counts other files only, so overwriting the big one is fine.
    await writeBuildFile(root, 'already-there', Buffer.from('shrunk'))
  })

  it('rejects a path crossing an existing file', async () => {
    await writeBuildFile(root, 'a', Buffer.from('file'))
    await expect(writeBuildFile(root, 'a/b', Buffer.from('x')))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('surfaces a write that fails for an unrelated reason', async () => {
    await fs.chmod(root, 0o500)
    await expect(writeBuildFile(root, 'a.txt', Buffer.from('x')))
      .rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('renameBuildFile', () => {
  it('renames a file, creating parent folders, and reports the new entry', async () => {
    await writeBuildFile(root, 'a.txt', Buffer.from('hello'))
    expect(await renameBuildFile(root, 'a.txt', 'nvim/lua/b.txt'))
      .toEqual({ path: 'nvim/lua/b.txt', size: 5, binary: false })
    expect(await fs.readFile(path.join(root, 'nvim/lua/b.txt'), 'utf8')).toBe('hello')
    await expect(readBuildFile(root, 'a.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('renames a folder recursively, and flags a renamed binary file', async () => {
    await writeBuildFile(root, 'nvim/init.lua', Buffer.from('x'))
    await writeBuildFile(root, 'nvim/lua/opts.lua', Buffer.from('y'))
    await renameBuildFile(root, 'nvim', 'editor')
    expect((await listBuildFiles(root)).map((f) => f.path))
      .toEqual(['editor/init.lua', 'editor/lua/opts.lua'])

    await writeBuildFile(root, 'blob', Buffer.from([0, 1, 2]))
    expect(await renameBuildFile(root, 'blob', 'theme.bin'))
      .toEqual({ path: 'theme.bin', size: 3, binary: true })
  })

  it('is a no-op success when source and destination are the same', async () => {
    await writeBuildFile(root, 'a.txt', Buffer.from('hi'))
    expect(await renameBuildFile(root, 'a.txt', './a.txt'))
      .toEqual({ path: 'a.txt', size: 2, binary: false })
  })

  it('throws NOT_FOUND for a missing source', async () => {
    await expect(renameBuildFile(root, 'nope', 'other'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses to clobber an existing destination', async () => {
    await writeBuildFile(root, 'a.txt', Buffer.from('a'))
    await writeBuildFile(root, 'b.txt', Buffer.from('b'))
    await expect(renameBuildFile(root, 'a.txt', 'b.txt'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    // Both files are untouched.
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('a')
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  it('rejects a destination path crossing an existing file', async () => {
    await writeBuildFile(root, 'a.txt', Buffer.from('a'))
    await writeBuildFile(root, 'b', Buffer.from('file'))
    await expect(renameBuildFile(root, 'a.txt', 'b/c'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('rejects escaping or reserved source and destination paths', async () => {
    await writeBuildFile(root, 'a.txt', Buffer.from('a'))
    await expect(renameBuildFile(root, 'a.txt', '../escape'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(renameBuildFile(root, 'a.txt', 'Dockerfile.user'))
      .rejects.toThrow(/Dockerfile editor/)
    await expect(renameBuildFile(root, '../etc/passwd', 'a.txt'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('surfaces a rename that fails for an unrelated reason', async () => {
    await writeBuildFile(root, 'a.txt', Buffer.from('a'))
    await fs.chmod(root, 0o500)
    await expect(renameBuildFile(root, 'a.txt', 'b.txt'))
      .rejects.toMatchObject({ code: 'EACCES' })
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

  it('refuses to delete outside the build dir or a root Dockerfile', async () => {
    await expect(deleteBuildFile(root, '../outside')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(deleteBuildFile(root, 'Dockerfile.yaac')).rejects.toThrow(/Dockerfile editor/)
  })
})
