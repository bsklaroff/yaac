import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { ServerError } from '@yaac/shared/errors'
import { repoDir, setDataDir, worktreeDir } from '@yaac/shared/project-paths'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { handleFixture, installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { addWorktree } from '#domain/git'
import {
  createWorktreeFolder,
  deleteWorktreeEntry,
  listWorktreeDir,
  listWorktreeFiles,
  readWorktreeFile,
  renameWorktreeEntry,
  writeWorktreeFile,
} from '#domain/worktrees'

/**
 * Real checkouts made by `addWorktree`, each with its `.git` file then
 * rewritten to a `/repo/...` path that does not exist here — exactly the
 * shape the server sees under k8s, where the in-pod setup points it at the
 * container's own view. Only the record lookup is faked: the driver answers
 * `find` with a handle naming the worktree asked for.
 */

const SLUG = 'demo'
let tmp: string
/** A folder beside the data dir: what an escaping link reaches for. */
let outside: string

async function makeCheckout(id: string): Promise<string> {
  const dir = worktreeDir(SLUG, id)
  await addWorktree(repoDir(SLUG), dir, `agent/${id}`)
  await fs.writeFile(path.join(dir, '.git'), `gitdir: /repo/.git/worktrees/${id}\n`)
  return dir
}

/** git inside a checkout whose `.git` file no longer resolves. */
function wtGit(id: string): ReturnType<typeof simpleGit> {
  return simpleGit(worktreeDir(SLUG, id)).env({
    ...process.env,
    GIT_DIR: path.join(repoDir(SLUG), '.git', 'worktrees', id),
    GIT_WORK_TREE: worktreeDir(SLUG, id),
  })
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ServerError)
  return { code: (err as ServerError).code, message: (err as ServerError).message }
}

async function write(dir: string, rel: string, content: string | Buffer = ''): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fs.writeFile(path.join(dir, rel), content)
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-files-'))
  setDataDir(path.join(tmp, 'data'))
  outside = path.join(tmp, 'outside')
  await write(outside, 'secret.txt', 'secret\n')

  const repo = repoDir(SLUG)
  await fs.mkdir(repo, { recursive: true })
  const git = simpleGit(repo)
  await git.init(['-b', 'main'])
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')
  await write(repo, '.gitignore', 'node_modules/\n*.log\nbuild/\n')
  await write(repo, 'a.txt', 'alpha\n')
  await write(repo, 'b.txt', 'bravo\n')
  await write(repo, 'd.txt', 'delta\n')
  await write(repo, 'conflict.txt', 'base\n')
  await write(repo, 'src/lib/util.ts', 'export {}\n')
  await git.add('.')
  await git.commit('initial')
})

// The fake is reset after every test, so it is installed before each.
beforeEach(() => {
  installFakeWorktreeDriver({
    find: (id) => Promise.resolve(handleFixture({ workspaceId: id, projectSlug: SLUG })),
  })
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('listWorktreeFiles', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('list')
    await write(dir, 'untracked.txt', 'u')
    await write(dir, 'debug.log', 'ignored')
    await write(dir, 'node_modules/x/index.js', 'ignored')
    await write(dir, 'pkg/build/out.js', 'ignored')
    await write(dir, 'pkg/keep.ts', 'kept')
    await fs.rm(path.join(dir, 'd.txt'))
    await fs.mkdir(path.join(dir, 'empty'))
    await fs.mkdir(path.join(dir, 'nest/inner'), { recursive: true })
    await fs.mkdir(path.join(dir, 'src/lib/fresh'))
    await write(dir, 'newpkg/file.ts', 'n')
    await fs.mkdir(path.join(dir, 'newpkg/tests'))
    await fs.symlink('a.txt', path.join(dir, 'link.txt'))
    await fs.symlink('src/lib', path.join(dir, 'lib'))
    await fs.symlink(path.relative(dir, path.join(outside, 'secret.txt')), path.join(dir, 'escape'))
    await fs.symlink('nowhere', path.join(dir, 'broken'))
  })

  it('lists tracked and untracked files, gitignore-aware, without deleted ones', async () => {
    const files = await listWorktreeFiles('list')
    expect(files.paths).toEqual(expect.arrayContaining([
      '.gitignore', 'a.txt', 'b.txt', 'src/lib/util.ts', 'untracked.txt', 'pkg/keep.ts', 'newpkg/file.ts',
    ]))
    expect(files.paths).not.toContain('d.txt')
    expect(files.paths).not.toContain('debug.log')
    expect(files.paths.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(files.truncated).toBe(false)
  })

  it('reports each symlink with where it leads', async () => {
    const { symlinks } = await listWorktreeFiles('list')
    expect(symlinks).toEqual({
      'link.txt': { target: 'a.txt', dir: false },
      lib: { target: 'src/lib', dir: true },
      escape: { target: null, dir: false },
      broken: { target: null, dir: false },
    })
  })

  it('collapses wholly ignored folders and keeps individually ignored files', async () => {
    const { ignored } = await listWorktreeFiles('list')
    expect(ignored).toEqual(expect.arrayContaining(['node_modules/', 'pkg/build/', 'debug.log']))
    expect(ignored.some((p) => p.startsWith('node_modules/x'))).toBe(false)
  })

  it('finds folders holding no file, at any depth, but not ones that hold one', async () => {
    const { emptyDirs } = await listWorktreeFiles('list')
    expect(emptyDirs).toEqual(expect.arrayContaining([
      'empty', 'nest', 'nest/inner', 'src/lib/fresh', 'newpkg/tests',
    ]))
    expect(emptyDirs).not.toContain('newpkg')
    expect(emptyDirs.some((d) => d.startsWith('node_modules') || d.startsWith('pkg'))).toBe(false)
  })

  it('reports git status against HEAD without writing the index', async () => {
    await makeCheckout('status')
    const git = wtGit('status')
    const wt = worktreeDir(SLUG, 'status')
    // A conflict first, while the tree is clean: the same file changed on
    // both sides of a merge.
    await simpleGit(repoDir(SLUG)).raw(['commit', '--allow-empty', '-m', 'noop'])
    await write(repoDir(SLUG), 'conflict.txt', 'theirs\n')
    await simpleGit(repoDir(SLUG)).add('conflict.txt').commit('theirs')
    await write(wt, 'conflict.txt', 'ours\n')
    await git.add('conflict.txt').commit('ours')
    await git.raw(['merge', 'main']).catch(() => { /* conflicts, as intended */ })

    await write(wt, 'a.txt', 'changed\n')
    await write(wt, 'staged.txt', 'new\n')
    await git.add('staged.txt')
    await write(wt, 'newdir/deep/x.txt', 'untracked\n')
    await git.raw(['mv', 'b.txt', 'renamed.txt'])
    await fs.rm(path.join(wt, 'd.txt'))

    const index = path.join(repoDir(SLUG), '.git', 'worktrees', 'status', 'index')
    // Make a tracked file's stat data stale so a status WOULD refresh it.
    const future = new Date(Date.now() + 60_000)
    await fs.utimes(path.join(wt, 'src/lib/util.ts'), future, future)
    const before = await fs.stat(index)

    const { status, paths } = await listWorktreeFiles('status')
    expect(status).toEqual({
      'a.txt': 'modified',
      'staged.txt': 'added',
      'newdir/deep/x.txt': 'untracked',
      'renamed.txt': 'added',
      'conflict.txt': 'conflicted',
    })
    expect(paths).not.toContain('d.txt')

    const after = await fs.stat(index)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('caps the listing and says so', async () => {
    const wt = await makeCheckout('big')
    const names = Array.from({ length: 50_001 }, (_, i) => `many/f${i}`)
    await fs.mkdir(path.join(wt, 'many'))
    for (let i = 0; i < names.length; i += 1000) {
      await Promise.all(names.slice(i, i + 1000).map((n) => fs.writeFile(path.join(wt, n), '')))
    }
    const files = await listWorktreeFiles('big')
    expect(files.paths).toHaveLength(50_000)
    expect(files.truncated).toBe(true)
    // Every file here is untracked; the status map shares the cap.
    expect(Object.keys(files.status)).toHaveLength(50_000)
  }, 120_000)
})

describe('listWorktreeDir', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('dir')
    await write(dir, 'node_modules/pkg/index.js', 'x')
    await fs.mkdir(path.join(dir, 'node_modules/pkg/lib'))
    await fs.symlink('index.js', path.join(dir, 'node_modules/pkg/main.js'))
    await fs.symlink('node_modules/pkg', path.join(dir, 'vendor'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
  })

  it('lists an ignored folder’s children with their kinds', async () => {
    const { entries, truncated } = await listWorktreeDir('dir', 'node_modules/pkg')
    expect(truncated).toBe(false)
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'index.js', dir: false },
      { name: 'lib', dir: true },
      { name: 'main.js', dir: false, symlink: { target: 'node_modules/pkg/index.js', dir: false } },
    ])
  })

  it('follows a folder link that stays inside the worktree', async () => {
    const { entries } = await listWorktreeDir('dir', 'vendor')
    expect(entries.map((e) => e.name).sort()).toEqual(['index.js', 'lib', 'main.js'])
  })

  it('refuses a link that leads outside, and a file', async () => {
    expect(await refusal(listWorktreeDir('dir', 'away')))
      .toEqual({ code: 'VALIDATION', message: 'away points outside the worktree' })
    expect((await refusal(listWorktreeDir('dir', 'a.txt'))).code).toBe('VALIDATION')
    expect((await refusal(listWorktreeDir('dir', 'missing'))).code).toBe('NOT_FOUND')
  })

  it('caps a large folder and says so', async () => {
    await fs.mkdir(path.join(dir, 'node_modules/huge'))
    await Promise.all(Array.from({ length: 5_001 }, (_, i) =>
      fs.writeFile(path.join(dir, `node_modules/huge/f${i}`), '')))
    const { entries, truncated } = await listWorktreeDir('dir', 'node_modules/huge')
    expect(entries).toHaveLength(5_000)
    expect(truncated).toBe(true)
  })
})

describe('readWorktreeFile', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('read')
    await write(dir, 'nul.bin', Buffer.from([0x61, 0x00, 0x62]))
    await write(dir, 'latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    await write(dir, 'big.txt', 'x'.repeat(1024 * 1024 + 1))
    await write(dir, 'exact.txt', 'x'.repeat(1024 * 1024))
    await write(dir, 'sub/f.txt', 'in sub\n')
    await fs.symlink('a.txt', path.join(dir, 'link.txt'))
    await fs.symlink('sub', path.join(dir, 'lnk'))
    await fs.symlink('hop2', path.join(dir, 'hop1'))
    await fs.symlink('a.txt', path.join(dir, 'hop2'))
    await fs.symlink(path.relative(dir, path.join(outside, 'secret.txt')), path.join(dir, 'up'))
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'abs'))
    await fs.symlink('.git', path.join(dir, 'gitlink'))
    await fs.mkdir(path.join(dir, 'inner'))
    await fs.symlink(path.relative(path.join(dir, 'inner'), outside), path.join(dir, 'inner/out'))
    await fs.symlink('inner', path.join(dir, 'via'))
  })

  it('reads a file with its version, and omits the content while that version holds', async () => {
    const file = await readWorktreeFile('read', 'a.txt')
    expect(file).toMatchObject({ path: 'a.txt', size: 6, binary: false, content: 'alpha\n' })
    expect(file.version).toMatch(/^[0-9a-f]{64}$/)
    const again = await readWorktreeFile('read', 'a.txt', file.version)
    expect(again).toEqual({ path: 'a.txt', version: file.version, size: 6, binary: false })
    const stale = await readWorktreeFile('read', 'a.txt', 'old')
    expect(stale.content).toBe('alpha\n')
  })

  it('refuses paths that are not plainly inside the worktree', async () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\0b', '.git/config', '.git']) {
      expect((await refusal(readWorktreeFile('read', bad))).code).toBe('VALIDATION')
    }
    expect((await refusal(readWorktreeFile('read', 'missing.txt'))).code).toBe('NOT_FOUND')
    expect((await refusal(readWorktreeFile('read', 'sub'))).code).toBe('VALIDATION')
  })

  it('gives binary and oversized files no content', async () => {
    expect(await readWorktreeFile('read', 'nul.bin')).toMatchObject({ binary: true, content: null })
    expect(await readWorktreeFile('read', 'latin1.txt')).toMatchObject({ binary: true, content: null })
    expect(await readWorktreeFile('read', 'big.txt')).toMatchObject({
      binary: false, content: null, size: 1024 * 1024 + 1,
    })
    expect((await readWorktreeFile('read', 'exact.txt')).content).toHaveLength(1024 * 1024)
  })

  it('follows links that land inside the worktree', async () => {
    expect((await readWorktreeFile('read', 'link.txt')).content).toBe('alpha\n')
    expect((await readWorktreeFile('read', 'lnk/f.txt')).content).toBe('in sub\n')
    expect((await readWorktreeFile('read', 'hop1')).content).toBe('alpha\n')
  })

  it('refuses links that land outside, or in .git', async () => {
    for (const bad of ['up', 'abs', 'gitlink', 'via/out/secret.txt']) {
      expect(await refusal(readWorktreeFile('read', bad)))
        .toEqual({ code: 'VALIDATION', message: `${bad} points outside the worktree` })
    }
  })
})

describe('writeWorktreeFile', () => {
  let dir: string
  const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), 'utf8')
  beforeAll(async () => {
    dir = await makeCheckout('write')
    await write(dir, 'sub/t.txt', 'target\n')
    await fs.symlink('sub/t.txt', path.join(dir, 'link.txt'))
    await fs.symlink('sub', path.join(dir, 'lnk'))
    await fs.symlink(path.relative(dir, path.join(outside, 'secret.txt')), path.join(dir, 'up'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
    await fs.symlink('nowhere', path.join(dir, 'dangle'))
  })

  it('saves against the version it read, and refuses a stale one with the current', async () => {
    const { version } = await readWorktreeFile('write', 'a.txt')
    const saved = await writeWorktreeFile('write', 'a.txt', 'one\n', version)
    if (!('saved' in saved)) throw new Error('the save was refused')
    expect(saved.saved).toMatchObject({ path: 'a.txt', size: 4 })
    expect(saved.saved.version).not.toBe(version)
    expect(await read('a.txt')).toBe('one\n')
    expect(await writeWorktreeFile('write', 'a.txt', 'two\n', version))
      .toEqual({ conflict: saved.saved.version })
    expect(await read('a.txt')).toBe('one\n')
  })

  it('creates a file and its folders, and a create conflicts with what is there', async () => {
    expect(await writeWorktreeFile('write', 'x/y/new.txt', 'n', null))
      .toMatchObject({ saved: { path: 'x/y/new.txt', size: 1 } })
    expect(await read('x/y/new.txt')).toBe('n')
    const { version } = await readWorktreeFile('write', 'b.txt')
    expect(await writeWorktreeFile('write', 'b.txt', 'clobber', null)).toEqual({ conflict: version })
    expect(await read('b.txt')).toBe('bravo\n')
  })

  it('never recreates a file that is gone', async () => {
    await write(dir, 'doomed.txt', 'd')
    const { version } = await readWorktreeFile('write', 'doomed.txt')
    await fs.rm(path.join(dir, 'doomed.txt'))
    expect(await writeWorktreeFile('write', 'doomed.txt', 'back', version)).toEqual({ conflict: null })
    await expect(fs.stat(path.join(dir, 'doomed.txt'))).rejects.toThrow()
  })

  it('writes in place, keeping the mode and inode', async () => {
    await write(dir, 'run.sh', '#!/bin/sh\n')
    await fs.chmod(path.join(dir, 'run.sh'), 0o755)
    const before = await fs.stat(path.join(dir, 'run.sh'))
    const { version } = await readWorktreeFile('write', 'run.sh')
    await writeWorktreeFile('write', 'run.sh', '#!/bin/sh\necho hi\n', version)
    const after = await fs.stat(path.join(dir, 'run.sh'))
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
    expect(await read('run.sh')).toBe('#!/bin/sh\necho hi\n')
  })

  it('saves through a link to the file it points to, leaving the link', async () => {
    const { version } = await readWorktreeFile('write', 'link.txt')
    await writeWorktreeFile('write', 'link.txt', 'via link\n', version)
    expect(await read('sub/t.txt')).toBe('via link\n')
    expect((await fs.lstat(path.join(dir, 'link.txt'))).isSymbolicLink()).toBe(true)
  })

  it('refuses a save through a link that leads outside, touching nothing', async () => {
    expect((await refusal(writeWorktreeFile('write', 'up', 'pwned', 'x'))).code).toBe('VALIDATION')
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
  })

  it('creates under a linked folder in its target, and refuses one that leads out', async () => {
    await writeWorktreeFile('write', 'lnk/made.txt', 'm', null)
    expect(await read('sub/made.txt')).toBe('m')
    expect((await refusal(writeWorktreeFile('write', 'away/planted.txt', 'p', null))).code)
      .toBe('VALIDATION')
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })

  it('refuses to create through a dangling link', async () => {
    expect((await refusal(writeWorktreeFile('write', 'dangle', 'x', null))).code).toBe('VALIDATION')
    expect(await fs.readlink(path.join(dir, 'dangle'))).toBe('nowhere')
  })
})

describe('createWorktreeFolder', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('folder')
    await fs.mkdir(path.join(dir, 'real'))
    await fs.symlink('real', path.join(dir, 'lnk'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
  })

  it('creates nested folders, and conflicts with an existing entry', async () => {
    expect(await createWorktreeFolder('folder', 'p/q/r')).toEqual({ path: 'p/q/r' })
    expect((await fs.stat(path.join(dir, 'p/q/r'))).isDirectory()).toBe(true)
    expect((await refusal(createWorktreeFolder('folder', 'p/q'))).code).toBe('CONFLICT')
    expect((await refusal(createWorktreeFolder('folder', 'a.txt'))).code).toBe('CONFLICT')
  })

  it('creates under a linked folder in its target, and refuses one that leads out', async () => {
    await createWorktreeFolder('folder', 'lnk/made')
    expect((await fs.stat(path.join(dir, 'real/made'))).isDirectory()).toBe(true)
    expect((await refusal(createWorktreeFolder('folder', 'away/planted'))).code).toBe('VALIDATION')
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })
})

describe('renameWorktreeEntry', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('rename')
    await write(dir, 'folder/inside.txt', 'i')
    await fs.symlink('a.txt', path.join(dir, 'link'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
  })

  it('moves files and folders, within and across folders', async () => {
    expect(await renameWorktreeEntry('rename', 'b.txt', 'c.txt')).toEqual({ from: 'b.txt', to: 'c.txt' })
    expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toBe('bravo\n')
    await renameWorktreeEntry('rename', 'folder', 'moved')
    expect(await fs.readFile(path.join(dir, 'moved/inside.txt'), 'utf8')).toBe('i')
    await renameWorktreeEntry('rename', 'c.txt', 'moved/deeper/c.txt')
    expect(await fs.readFile(path.join(dir, 'moved/deeper/c.txt'), 'utf8')).toBe('bravo\n')
  })

  it('renames a link as the link', async () => {
    await renameWorktreeEntry('rename', 'link', 'relinked')
    expect(await fs.readlink(path.join(dir, 'relinked'))).toBe('a.txt')
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n')
  })

  it('refuses a taken destination, a move into itself, .git, and a way out', async () => {
    expect((await refusal(renameWorktreeEntry('rename', 'a.txt', 'd.txt'))).code).toBe('CONFLICT')
    expect((await refusal(renameWorktreeEntry('rename', 'moved', 'moved/sub'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorktreeEntry('rename', 'a.txt', '.git/hooks/x'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorktreeEntry('rename', '.git', 'g'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorktreeEntry('rename', 'a.txt', 'away/a.txt'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorktreeEntry('rename', 'missing', 'x'))).code).toBe('NOT_FOUND')
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n')
  })
})

describe('deleteWorktreeEntry', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('delete')
    await fs.symlink(path.relative(dir, path.join(outside, 'secret.txt')), path.join(dir, 'link'))
    await write(dir, 'tree/a/b.txt', 'b')
    await write(dir, 'tree/c.txt', 'c')
    await write(outside, 'deep/keep.txt', 'keep')
    await write(dir, 'holder/plain.txt', 'p')
    await fs.symlink(path.relative(path.join(dir, 'holder'), path.join(outside, 'deep')), path.join(dir, 'holder/out'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
  })

  it('deletes a file, and a link without what it points to', async () => {
    await deleteWorktreeEntry('delete', 'a.txt')
    await expect(fs.stat(path.join(dir, 'a.txt'))).rejects.toThrow()
    await deleteWorktreeEntry('delete', 'link')
    await expect(fs.lstat(path.join(dir, 'link'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
  })

  it('deletes a folder recursively, never following a link inside it', async () => {
    await deleteWorktreeEntry('delete', 'tree')
    await expect(fs.stat(path.join(dir, 'tree'))).rejects.toThrow()
    await deleteWorktreeEntry('delete', 'holder')
    await expect(fs.lstat(path.join(dir, 'holder'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'deep/keep.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a path through a link that leads out, and a missing one', async () => {
    expect((await refusal(deleteWorktreeEntry('delete', 'away/secret.txt'))).code).toBe('VALIDATION')
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
    expect((await refusal(deleteWorktreeEntry('delete', 'missing'))).code).toBe('NOT_FOUND')
  })
})
