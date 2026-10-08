import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ServerError } from '@yaac/shared/errors'
import { repoDir, setDataDir, workspaceDir } from '@yaac/shared/project-paths'
import { testTmpBase } from '@yaac/test-utils/tmp'
import { handleFixture, installFakeWorkspaceDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { createCheckout } from '#domain/git'
import { execFileAsync } from '#lib/shell'
import {
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  getWorkspaceChanges,
  listWorkspaceDir,
  readWorkspaceFile,
  readWorkspaceFileAtRev,
  renameWorkspaceEntry,
  writeWorkspaceFile,
} from '#domain/workspaces'
import { git } from '@yaac/test-utils/git'
import { buildChangesScript, parseChangesOutput } from '#drivers/shared'
import {
  CHANGES_BASE_UNRESOLVED, CHANGES_BUSY, WorkspaceExecError, type ChangesReading, type ChangesRequest,
} from '#drivers/contract'
import { BUILT_IN_USER_ID, recordProject } from '#db'
import type { WorkspaceFiles } from '@yaac/shared/types'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/**
 * Real checkouts made by `createCheckout` from a local main clone. Only the
 * driver is faked: `find` returns a running handle (a stopped one for
 * `stopped`), and commands, the changes script among them, run in a host
 * shell in the checkout, as they do for a containerless workspace.
 */

const PROJECT = '7d4e2a1c-5b3f-4e8a-9c6d-1f2e3a4b5c6d'
let tmp: string
/** A folder outside the data dir, the target of escaping symlinks. */
let outside: string

async function makeCheckout(id: string): Promise<string> {
  const dir = workspaceDir(PROJECT, id)
  await createCheckout(repoDir(PROJECT), dir, { branch: `agent/${id}`, baseBranch: 'main', remoteUrl: 'https://example.invalid/r.git' })
  return dir
}

function wtGit(id: string): (args: string[]) => Promise<string> {
  return (args) => git(workspaceDir(PROJECT, id), args)
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(ServerError)
  return { code: (err as ServerError).code, message: (err as ServerError).message }
}

/** A link target that leaves for `via` and comes back to `to`, without
 *  normalizing away the trip. */
function roundTrip(linkDir: string, via: string, to: string): string {
  return `${path.relative(linkDir, via)}/${path.relative(via, to)}`
}

async function write(dir: string, rel: string, content: string | Buffer = ''): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fs.writeFile(path.join(dir, rel), content)
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(testTmpBase(), 'yaac-files-'))
  setDataDir(path.join(tmp, 'data'))
  await recordProject({ id: PROJECT, name: 'demo', remoteUrl: 'https://github.com/o/r', addedAt: 'now' }, BUILT_IN_USER_ID)
  outside = path.join(tmp, 'outside')
  await write(outside, 'secret.txt', 'secret\n')

  const repo = repoDir(PROJECT)
  await fs.mkdir(repo, { recursive: true })
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@test.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await write(repo, '.gitignore', 'node_modules/\n*.log\nbuild/\n')
  await write(repo, 'a.txt', 'alpha\n')
  await write(repo, 'b.txt', 'bravo\n')
  await write(repo, 'd.txt', 'delta\n')
  await write(repo, 'conflict.txt', 'base\n')
  await write(repo, 'src/lib/util.ts', 'export {}\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'initial'])
  // Like a real main clone, with the remote's branches under origin/.
  await git(repo, ['update-ref', 'refs/remotes/origin/main', 'main'])
  await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
})

// The test setup resets the fake driver after every test.
beforeEach(() => {
  installFakeWorkspaceDriver({
    find: (id) => Promise.resolve(handleFixture({
      workspaceId: id, projectId: PROJECT, jobName: id,
      ...(id === 'stopped' ? { running: false, state: 'stopped' } : {}),
    })),
    workspacePaths: (jobName) => workspacePathsFixture({ workspaceDir: workspaceDir(PROJECT, jobName) }),
    exec: async (_jobName, cmd) => execFileAsync('sh', ['-c', cmd], { maxBuffer: 64 << 20 }),
    changes: hostChanges,
  })
})

/** The changes script run in a host shell, as the containerless driver does. */
async function hostChanges(jobName: string, request: ChangesRequest): Promise<ChangesReading> {
  const script = buildChangesScript({
    workspaceDir: workspaceDir(PROJECT, jobName),
    indexFile: path.join(tmp, `${jobName}.idx`),
  }, request)
  const { stdout } = await execFileAsync('sh', ['-c', script], { maxBuffer: 64 << 20 }).catch((err: unknown) => {
    const { code } = err as { code?: number }
    throw typeof code === 'number' ? new WorkspaceExecError(`exited ${code}`, code, '', '') : err
  })
  return parseChangesOutput(stdout)
}

/** A `full` listing of a workspace, which the explorer asks for. */
async function listing(id: string): Promise<WorkspaceFiles> {
  const { listing: out } = await getWorkspaceChanges(id, undefined, { diff: false, listing: 'full' })
  expect(out).toBeDefined()
  return out!
}

afterAll(async () => {
  await closeDb()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('getWorkspaceChanges', () => {
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
    const files = await listing('list')
    // Sent again only when it changed; the walks run only for `full`.
    const again = await getWorkspaceChanges('list', undefined, { diff: false, listing: 'full', known: files.version })
    expect(again.listing).toBeUndefined()
    const { listing: cheap } = await getWorkspaceChanges('list', undefined, { diff: false, listing: 'paths' })
    expect(cheap).toMatchObject({ paths: files.paths, symlinks: files.symlinks, ignored: [], emptyDirs: [] })
    expect(cheap?.version).not.toBe(files.version)
    expect(files.paths).toEqual(expect.arrayContaining([
      '.gitignore', 'a.txt', 'b.txt', 'src/lib/util.ts', 'untracked.txt', 'pkg/keep.ts', 'newpkg/file.ts',
    ]))
    expect(files.paths).not.toContain('d.txt')
    expect(files.paths).not.toContain('debug.log')
    expect(files.paths.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(files.truncated).toBe(false)
  })

  it('reports each symlink with where it leads', async () => {
    const { symlinks } = await listing('list')
    expect(symlinks).toEqual({
      'link.txt': { target: 'a.txt', dir: false },
      lib: { target: 'src/lib', dir: true },
      escape: { target: null, dir: false },
      broken: { target: null, dir: false },
    })

    // The workspace runs the script, so its listing may name any path. One
    // the file routes would refuse is dropped unopened, and a link is
    // resolved only from a folder inside the checkout.
    await fs.symlink(outside, path.join(dir, 'outdir'))
    try {
      const honest = await listing('list')
      const crafted = ['../../outside/secret.txt', '/etc/passwd', '.git/config', './a.txt', '..', 'src/../..']
      installFakeWorkspaceDriver({
        find: (id) => Promise.resolve(handleFixture({ workspaceId: id, projectId: PROJECT, jobName: id })),
        changes: async (jobName, request) => {
          const reading = await hostChanges(jobName, request)
          const read = reading.listing!
          return {
            ...reading,
            listing: {
              paths: [...read.paths, ...crafted],
              links: [...read.links, ...crafted, 'outdir/secret.txt'],
              ignored: [...read.ignored!, ...crafted.map((p) => `${p}/`)],
              untrackedDirs: [...read.untrackedDirs!, ...crafted],
              conflicted: [...read.conflicted, ...crafted],
            },
          }
        },
      })
      // Where each resolved path's folder really is, at the time of the
      // call, leaving out opening the checkout itself.
      const realpathOf = fs.realpath.bind(fs)
      const root = await realpathOf(dir)
      const resolvedFrom: string[] = []
      const realpath = vi.spyOn(fs, 'realpath').mockImplementation(async (p, ...rest) => {
        const from = await realpathOf(path.dirname(String(p)))
        const real = await realpathOf(p, ...rest)
        if (real !== root) resolvedFrom.push(from)
        return real
      })
      try {
        const { version: _, ...out } = await listing('list')
        const { version: __, ...expected } = honest
        expect(out).toEqual({
          ...expected,
          symlinks: { ...honest.symlinks, 'outdir/secret.txt': { target: null, dir: false } },
        })
        expect(resolvedFrom.filter((d) => d !== root && !d.startsWith(`${root}/`))).toEqual([])
      } finally {
        realpath.mockRestore()
      }
    } finally {
      await fs.rm(path.join(dir, 'outdir'))
    }
  })

  it('collapses wholly ignored folders and keeps individually ignored files', async () => {
    const { ignored } = await listing('list')
    expect(ignored).toEqual(expect.arrayContaining(['node_modules/', 'pkg/build/', 'debug.log']))
    expect(ignored.some((p) => p.startsWith('node_modules/x'))).toBe(false)
  })

  it('finds folders holding no file, at any depth, but not ones that hold one', async () => {
    const { emptyDirs } = await listing('list')
    expect(emptyDirs).toEqual(expect.arrayContaining([
      'empty', 'nest', 'nest/inner', 'src/lib/fresh', 'newpkg/tests',
    ]))
    expect(emptyDirs).not.toContain('newpkg')
    expect(emptyDirs.some((d) => d.startsWith('node_modules') || d.startsWith('pkg'))).toBe(false)
  })

  it('reports merge conflicts without writing the index', async () => {
    await makeCheckout('status')
    const inWt = wtGit('status')
    const wt = workspaceDir(PROJECT, 'status')
    // Create a merge conflict first, while the tree is clean.
    await git(repoDir(PROJECT), ['commit', '--allow-empty', '-m', 'noop'])
    await write(repoDir(PROJECT), 'conflict.txt', 'theirs\n')
    await git(repoDir(PROJECT), ['add', 'conflict.txt'])
    await git(repoDir(PROJECT), ['commit', '-m', 'theirs'])
    await write(wt, 'conflict.txt', 'ours\n')
    await inWt(['add', 'conflict.txt'])
    await inWt(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'ours'])
    // The checkout sees main's objects through its alternate.
    const theirs = (await git(repoDir(PROJECT), ['rev-parse', 'main'])).trim()
    await inWt(['-c', 'user.email=t@t', '-c', 'user.name=T', 'merge', theirs]).catch(() => { /* conflicts, as intended */ })

    await write(wt, 'a.txt', 'changed\n')
    await write(wt, 'staged.txt', 'new\n')
    await inWt(['add', 'staged.txt'])
    await write(wt, 'newdir/deep/x.txt', 'untracked\n')
    await inWt(['mv', 'b.txt', 'renamed.txt'])
    await fs.rm(path.join(wt, 'd.txt'))

    const index = path.join(wt, '.git', 'index')
    // Make a tracked file's stat data stale so a status WOULD refresh it.
    const future = new Date(Date.now() + 60_000)
    await fs.utimes(path.join(wt, 'src/lib/util.ts'), future, future)
    const before = await fs.stat(index)

    const { conflicted, paths } = await listing('status')
    expect(conflicted).toEqual(['conflict.txt'])
    expect(paths).not.toContain('d.txt')
    expect(paths).toEqual(expect.arrayContaining(['renamed.txt', 'staged.txt', 'newdir/deep/x.txt']))

    const after = await fs.stat(index)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  // An agent's scaffold or test fixture often `git init`s a folder; git
  // cannot index one with no commit, which must cost only that folder.
  it('lists and diffs around a nested repo with no commit', async () => {
    const wt = await makeCheckout('nested')
    await git(wt, ['init', '-q', 'scaffold'])
    await write(wt, 'scaffold/inner.txt', 'x\n')
    await write(wt, 'plain.txt', 'p\n')
    const changes = await getWorkspaceChanges('nested', undefined, { listing: 'full' })
    expect(changes.files.map((f) => f.path)).toEqual(['plain.txt'])
    expect(changes.listing?.paths).toEqual(expect.arrayContaining(['a.txt', 'plain.txt']))
  })

  it('caps the listing and says so', async () => {
    const wt = await makeCheckout('big')
    const names = Array.from({ length: 50_001 }, (_, i) => `many/f${i}`)
    await fs.mkdir(path.join(wt, 'many'))
    for (let i = 0; i < names.length; i += 1000) {
      await Promise.all(names.slice(i, i + 1000).map((n) => fs.writeFile(path.join(wt, n), '')))
    }
    const files = await listing('big')
    expect(files.paths).toHaveLength(50_000)
    expect(files.truncated).toBe(true)
  }, 120_000)

  it('says how far HEAD is from the base branch, the fork branch unless one is picked', async () => {
    // One commit on the checkout's branch, and one on main after the fork,
    // fetched into the checkout.
    await git(repoDir(PROJECT), ['update-ref', 'refs/remotes/origin/main', 'main'])
    await makeCheckout('gs')
    const run = wtGit('gs')
    await run(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'agent work'])
    await git(repoDir(PROJECT), ['commit', '--allow-empty', '-m', 'landed on main'])
    await git(repoDir(PROJECT), ['update-ref', 'refs/remotes/origin/main', 'main'])
    await run(['fetch', '-q', path.join(repoDir(PROJECT), '.git'), 'refs/remotes/origin/*:refs/remotes/origin/*'])
    await recordWorkspaceCreated({ projectId: PROJECT, workspaceId: 'gs', baseBranch: 'main' })

    const fork = await getWorkspaceChanges('gs', undefined, { diff: false })
    expect(fork).toMatchObject({ branch: 'main', comparison: { ref: 'origin/main', ahead: 1, behind: 1 } })
    expect(fork.comparison?.fetchedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    expect(fork.listing).toBeUndefined()
    // An unpushed branch is compared locally, with no fetch time.
    await expect(getWorkspaceChanges('gs', 'agent/gs', { diff: false })).resolves.toMatchObject({
      branch: 'agent/gs', comparison: { ref: 'agent/gs', ahead: 0, behind: 0 },
    })
    expect((await getWorkspaceChanges('gs', 'agent/gs', { diff: false })).comparison).not.toHaveProperty('fetchedAt')
    // A picked base that resolves nowhere, or is not a branch, is the
    // caller's mistake.
    for (const bad of ['gone', 'main..HEAD']) {
      const err = await refusal(getWorkspaceChanges('gs', bad))
      expect(err.code).toBe('VALIDATION')
      expect(err.message).toContain(bad)
    }
  })

  it('answers only while the workspace runs', async () => {
    expect((await refusal(getWorkspaceChanges('stopped', 'main'))).code).toBe('CONFLICT')
    // A stopped workspace with nothing left on the substrate still exists.
    installFakeWorkspaceDriver({ find: () => Promise.resolve(undefined) })
    expect((await refusal(getWorkspaceChanges('gs'))).code).toBe('CONFLICT')
    expect((await refusal(getWorkspaceChanges('nope'))).code).toBe('NOT_FOUND')
  })

  // Once the agent pushes its branch, @{upstream} is the branch itself and
  // the runtime's default base shows an empty diff. Diffing against the fork
  // branch keeps committed work visible until it merges.
  it('offers the recorded fork branch as the default base, and lets a picked one win', async () => {
    const mockChanges = vi.fn(hostChanges)
    installFakeWorkspaceDriver({
      find: (id) => Promise.resolve(handleFixture({ workspaceId: id, projectId: PROJECT, jobName: id })),
      changes: mockChanges,
    })
    await getWorkspaceChanges('gs', undefined, { diff: false, listing: 'paths' })
    await getWorkspaceChanges('gs', 'agent/gs')
    await getWorkspaceChanges('list', undefined, { diff: false })
    expect(mockChanges.mock.calls).toEqual([
      ['gs', { base: undefined, defaultBase: 'main', diff: false, listing: 'paths' }],
      ['gs', { base: 'agent/gs', defaultBase: 'main', diff: true, listing: undefined }],
      // Nothing records a fork branch for this one.
      ['list', { base: undefined, defaultBase: undefined, diff: false, listing: undefined }],
    ])
  })

  // With no explicit base, the recorded fork branch failed to resolve. That
  // is a server fault, not the caller's; so is any other failed run, since
  // it says nothing about the ref (exit 3 means "no checkout").
  it('keeps every failure but a bad picked base or a busy run a server fault', async () => {
    let failure = new WorkspaceExecError('command exited 4', CHANGES_BASE_UNRESOLVED, '', '')
    installFakeWorkspaceDriver({
      find: (id) => Promise.resolve(handleFixture({ workspaceId: id, projectId: PROJECT, jobName: id })),
      changes: () => Promise.reject(failure),
    })
    await expect(getWorkspaceChanges('gs')).rejects.toBe(failure)
    failure = new WorkspaceExecError('command exited 3', 3, '', '')
    await expect(getWorkspaceChanges('gs', 'dev')).rejects.toBe(failure)
    // An earlier run that outlived its request is worth retrying.
    failure = new WorkspaceExecError('command exited 7', CHANGES_BUSY, '', '')
    expect((await refusal(getWorkspaceChanges('gs'))).code).toBe('RUNTIME_UNAVAILABLE')
  })
})

describe('readWorkspaceFileAtRev', () => {
  let base: string
  beforeAll(async () => {
    const dir = await makeCheckout('at')
    base = (await wtGit('at')(['rev-parse', 'HEAD'])).trim()
    await write(dir, 'a.txt', 'edited\n')
    await write(dir, 'bin.dat', Buffer.from([0x00, 0x01]))
    await write(dir, 'big.txt', 'x'.repeat(1024 * 1024 + 1))
    await write(dir, 'odd name\'s.txt', 'quoted\n')
    const run = wtGit('at')
    await run(['add', '-A'])
    await run(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'more'])
  })

  // The base's text, not the working copy's, and every way it can be
  // missing: no such file then, a binary or oversized one, a folder.
  it('reads a file as it was at a commit', async () => {
    await expect(readWorkspaceFileAtRev('at', 'a.txt', base)).resolves.toEqual({ exists: true, content: 'alpha\n' })
    await expect(readWorkspaceFileAtRev('at', 'bin.dat', base)).resolves.toEqual({ exists: false, content: null })
    await expect(readWorkspaceFileAtRev('at', 'src/lib', base)).resolves.toEqual({ exists: false, content: null })
    const head = (await wtGit('at')(['rev-parse', 'HEAD'])).trim()
    await expect(readWorkspaceFileAtRev('at', 'bin.dat', head)).resolves.toEqual({ exists: true, content: null })
    await expect(readWorkspaceFileAtRev('at', 'big.txt', head)).resolves.toEqual({ exists: true, content: null })
    await expect(readWorkspaceFileAtRev('at', 'odd name\'s.txt', head)).resolves.toEqual({ exists: true, content: 'quoted\n' })
  })

  it('refuses anything but a commit id, a path outside, and a stopped workspace', async () => {
    expect((await refusal(readWorkspaceFileAtRev('at', 'a.txt', 'HEAD'))).code).toBe('VALIDATION')
    expect((await refusal(readWorkspaceFileAtRev('at', 'a.txt', `--output=/tmp/x${'0'.repeat(31)}`))).code).toBe('VALIDATION')
    expect((await refusal(readWorkspaceFileAtRev('at', '../x', base))).code).toBe('VALIDATION')
    expect((await refusal(readWorkspaceFileAtRev('stopped', 'a.txt', base))).code).toBe('CONFLICT')
  })
})

describe('listWorkspaceDir', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('dir')
    await write(dir, 'node_modules/pkg/index.js', 'x')
    await fs.mkdir(path.join(dir, 'node_modules/pkg/lib'))
    await fs.symlink('index.js', path.join(dir, 'node_modules/pkg/main.js'))
    await fs.symlink('node_modules/pkg', path.join(dir, 'vendor'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
    await fs.mkdir(path.join(dir, 'round'))
    const round = path.join(dir, 'round')
    await fs.symlink('../a.txt', path.join(round, 'in'))
    await fs.symlink(roundTrip(round, outside, path.join(dir, 'a.txt')), path.join(round, 'there'))
    await fs.symlink(roundTrip(round, path.join(outside, 'nothing'), path.join(dir, 'a.txt')), path.join(round, 'absent'))
  })

  it('lists an ignored folder’s children with their kinds', async () => {
    const { entries, truncated } = await listWorkspaceDir('dir', 'node_modules/pkg')
    expect(truncated).toBe(false)
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'index.js', dir: false },
      { name: 'lib', dir: true },
      { name: 'main.js', dir: false, symlink: { target: 'node_modules/pkg/index.js', dir: false } },
    ])
  })

  it('reports a link that leaves and comes back as leading nowhere, whether or not the way out exists', async () => {
    const { entries } = await listWorkspaceDir('dir', 'round')
    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'absent', dir: false, symlink: { target: null, dir: false } },
      { name: 'in', dir: false, symlink: { target: 'a.txt', dir: false } },
      { name: 'there', dir: false, symlink: { target: null, dir: false } },
    ])
  })

  it('follows a folder link that stays inside the workspace', async () => {
    const { entries } = await listWorkspaceDir('dir', 'vendor')
    expect(entries.map((e) => e.name).sort()).toEqual(['index.js', 'lib', 'main.js'])
  })

  it('refuses a link that leads outside, and a file', async () => {
    expect(await refusal(listWorkspaceDir('dir', 'away')))
      .toEqual({ code: 'VALIDATION', message: 'away points outside the workspace' })
    expect((await refusal(listWorkspaceDir('dir', 'a.txt'))).code).toBe('VALIDATION')
    expect((await refusal(listWorkspaceDir('dir', 'missing'))).code).toBe('NOT_FOUND')
  })

  it('caps a large folder and says so', async () => {
    await fs.mkdir(path.join(dir, 'node_modules/huge'))
    await Promise.all(Array.from({ length: 5_001 }, (_, i) =>
      fs.writeFile(path.join(dir, `node_modules/huge/f${i}`), '')))
    const { entries, truncated } = await listWorkspaceDir('dir', 'node_modules/huge')
    expect(entries).toHaveLength(5_000)
    expect(truncated).toBe(true)
  })
})

describe('readWorkspaceFile', () => {
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
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
    await fs.symlink(path.join(outside, 'nothing'), path.join(dir, 'absent'))
    await fs.symlink('nothing', path.join(dir, 'broken'))
    await fs.symlink(roundTrip(dir, outside, path.join(dir, 'a.txt')), path.join(dir, 'there'))
    await fs.symlink(roundTrip(dir, path.join(outside, 'nothing'), path.join(dir, 'a.txt')), path.join(dir, 'gone'))
    await fs.mkdir(path.join(dir, 'xo'))
    await fs.symlink(path.relative(path.join(dir, 'xo'), path.join(outside, 'secret.txt')), path.join(dir, 'xo/e'))
    await fs.symlink(path.relative(path.join(dir, 'xo'), path.join(outside, 'nothing')), path.join(dir, 'xo/m'))
  })

  it('reads a file with its version, and omits the content while that version holds', async () => {
    const file = await readWorkspaceFile('read', 'a.txt')
    expect(file).toMatchObject({ path: 'a.txt', size: 6, binary: false, content: 'alpha\n' })
    expect(file.version).toMatch(/^[0-9a-f]{64}$/)
    const again = await readWorkspaceFile('read', 'a.txt', file.version)
    expect(again).toEqual({ path: 'a.txt', version: file.version, size: 6, binary: false })
    const stale = await readWorkspaceFile('read', 'a.txt', 'old')
    expect(stale.content).toBe('alpha\n')
  })

  it('refuses paths that are not plainly inside the workspace', async () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\0b', '.git/config', '.git']) {
      expect((await refusal(readWorkspaceFile('read', bad))).code).toBe('VALIDATION')
    }
    expect((await refusal(readWorkspaceFile('read', 'missing.txt'))).code).toBe('NOT_FOUND')
    expect((await refusal(readWorkspaceFile('read', 'sub'))).code).toBe('VALIDATION')
  })

  it('refuses a FIFO at once rather than waiting for a writer', async () => {
    await execFileAsync('mkfifo', [path.join(dir, 'pipe')])
    expect(await refusal(readWorkspaceFile('read', 'pipe')))
      .toEqual({ code: 'VALIDATION', message: 'pipe is not a regular file' })
  })

  it('gives binary and oversized files no content', async () => {
    expect(await readWorkspaceFile('read', 'nul.bin')).toMatchObject({ binary: true, content: null })
    expect(await readWorkspaceFile('read', 'latin1.txt')).toMatchObject({ binary: true, content: null })
    expect(await readWorkspaceFile('read', 'big.txt')).toMatchObject({
      binary: false, content: null, size: 1024 * 1024 + 1,
    })
    expect((await readWorkspaceFile('read', 'exact.txt')).content).toHaveLength(1024 * 1024)
  })

  it('follows links that land inside the workspace', async () => {
    expect((await readWorkspaceFile('read', 'link.txt')).content).toBe('alpha\n')
    expect((await readWorkspaceFile('read', 'lnk/f.txt')).content).toBe('in sub\n')
    expect((await readWorkspaceFile('read', 'hop1')).content).toBe('alpha\n')
  })

  it('refuses links that land outside, or in .git, whether or not the target exists', async () => {
    for (const bad of [
      'up', 'abs', 'gitlink', 'via/out/secret.txt', 'via/out/nothing', 'away/nothing',
      'away/nothing/x', 'away/secret.txt/x', 'absent', 'there', 'gone',
    ]) {
      expect(await refusal(readWorkspaceFile('read', bad)))
        .toEqual({ code: 'VALIDATION', message: `${bad} points outside the workspace` })
    }
    expect((await refusal(readWorkspaceFile('read', 'broken'))).code).toBe('NOT_FOUND')
  })

  it('answers the same through a search-only folder whether or not the outside target exists', async () => {
    await fs.chmod(path.join(dir, 'xo'), 0o111)
    try {
      const existing = await refusal(readWorkspaceFile('read', 'xo/e'))
      const missing = await refusal(readWorkspaceFile('read', 'xo/m'))
      expect(missing).toEqual({ ...existing, message: existing.message.replace('xo/e', 'xo/m') })
    } finally {
      await fs.chmod(path.join(dir, 'xo'), 0o755)
    }
  })
})

describe('writeWorkspaceFile', () => {
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
    await fs.symlink(path.join(outside, 'nothing'), path.join(dir, 'gone'))
  })

  it('saves against the version it read, and refuses a stale one with the current', async () => {
    const { version } = await readWorkspaceFile('write', 'a.txt')
    const saved = await writeWorkspaceFile(local, 'write', 'a.txt', 'one\n', version)
    if (!('saved' in saved)) throw new Error('the save was refused')
    expect(saved.saved).toMatchObject({ path: 'a.txt', size: 4 })
    expect(saved.saved.version).not.toBe(version)
    expect(await read('a.txt')).toBe('one\n')
    expect(await writeWorkspaceFile(local, 'write', 'a.txt', 'two\n', version))
      .toEqual({ conflict: saved.saved.version })
    expect(await read('a.txt')).toBe('one\n')
  })

  it('creates a file and its folders, and a create conflicts with what is there', async () => {
    expect(await writeWorkspaceFile(local, 'write', 'x/y/new.txt', 'n', null))
      .toMatchObject({ saved: { path: 'x/y/new.txt', size: 1 } })
    expect(await read('x/y/new.txt')).toBe('n')
    const deep = `${Array.from({ length: 45 }, (_, i) => `d${i}`).join('/')}/new.txt`
    expect(await writeWorkspaceFile(local, 'write', deep, 'd', null)).toMatchObject({ saved: { path: deep } })
    const { version } = await readWorkspaceFile('write', 'b.txt')
    expect(await writeWorkspaceFile(local, 'write', 'b.txt', 'clobber', null)).toEqual({ conflict: version })
    expect(await read('b.txt')).toBe('bravo\n')
  })

  it('never recreates a file that is gone', async () => {
    await write(dir, 'doomed.txt', 'd')
    const { version } = await readWorkspaceFile('write', 'doomed.txt')
    await fs.rm(path.join(dir, 'doomed.txt'))
    expect(await writeWorkspaceFile(local, 'write', 'doomed.txt', 'back', version)).toEqual({ conflict: null })
    await expect(fs.stat(path.join(dir, 'doomed.txt'))).rejects.toThrow()
  })

  it('writes in place, keeping the mode and inode', async () => {
    await write(dir, 'run.sh', '#!/bin/sh\n')
    await fs.chmod(path.join(dir, 'run.sh'), 0o755)
    const before = await fs.stat(path.join(dir, 'run.sh'))
    const { version } = await readWorkspaceFile('write', 'run.sh')
    await writeWorkspaceFile(local, 'write', 'run.sh', '#!/bin/sh\necho hi\n', version)
    const after = await fs.stat(path.join(dir, 'run.sh'))
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
    expect(await read('run.sh')).toBe('#!/bin/sh\necho hi\n')
  })

  it('saves through a link to the file it points to, leaving the link', async () => {
    const { version } = await readWorkspaceFile('write', 'link.txt')
    await writeWorkspaceFile(local, 'write', 'link.txt', 'via link\n', version)
    expect(await read('sub/t.txt')).toBe('via link\n')
    expect((await fs.lstat(path.join(dir, 'link.txt'))).isSymbolicLink()).toBe(true)
  })

  it('refuses a save through a link that leads outside, touching nothing', async () => {
    expect((await refusal(writeWorkspaceFile(local, 'write', 'up', 'pwned', 'x'))).code).toBe('VALIDATION')
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
  })

  it('creates under a linked folder in its target, and refuses one that leads out', async () => {
    await writeWorkspaceFile(local, 'write', 'lnk/made.txt', 'm', null)
    expect(await read('sub/made.txt')).toBe('m')
    for (const bad of ['away/planted.txt', 'gone/planted.txt']) {
      expect((await refusal(writeWorkspaceFile(local, 'write', bad, 'p', null))).code).toBe('VALIDATION')
    }
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })

  it('refuses to create through a dangling link', async () => {
    expect((await refusal(writeWorkspaceFile(local, 'write', 'dangle', 'x', null))).code).toBe('VALIDATION')
    expect(await fs.readlink(path.join(dir, 'dangle'))).toBe('nowhere')
  })
})

describe('createWorkspaceFolder', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('folder')
    await fs.mkdir(path.join(dir, 'real'))
    await fs.symlink('real', path.join(dir, 'lnk'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
  })

  it('creates nested folders, and conflicts with an existing entry', async () => {
    expect(await createWorkspaceFolder(local, 'folder', 'p/q/r')).toEqual({ path: 'p/q/r' })
    expect((await fs.stat(path.join(dir, 'p/q/r'))).isDirectory()).toBe(true)
    expect((await refusal(createWorkspaceFolder(local, 'folder', 'p/q'))).code).toBe('CONFLICT')
    expect((await refusal(createWorkspaceFolder(local, 'folder', 'a.txt'))).code).toBe('CONFLICT')
  })

  it('creates under a linked folder in its target, and refuses one that leads out', async () => {
    await createWorkspaceFolder(local, 'folder', 'lnk/made')
    expect((await fs.stat(path.join(dir, 'real/made'))).isDirectory()).toBe(true)
    expect((await refusal(createWorkspaceFolder(local, 'folder', 'away/planted'))).code).toBe('VALIDATION')
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })
})

describe('renameWorkspaceEntry', () => {
  let dir: string
  beforeAll(async () => {
    dir = await makeCheckout('rename')
    await write(dir, 'folder/inside.txt', 'i')
    await fs.symlink('a.txt', path.join(dir, 'link'))
    await fs.symlink(path.relative(dir, outside), path.join(dir, 'away'))
  })

  it('moves files and folders, within and across folders', async () => {
    expect(await renameWorkspaceEntry(local, 'rename', 'b.txt', 'c.txt')).toEqual({ from: 'b.txt', to: 'c.txt' })
    expect(await fs.readFile(path.join(dir, 'c.txt'), 'utf8')).toBe('bravo\n')
    await renameWorkspaceEntry(local, 'rename', 'folder', 'moved')
    expect(await fs.readFile(path.join(dir, 'moved/inside.txt'), 'utf8')).toBe('i')
    await renameWorkspaceEntry(local, 'rename', 'c.txt', 'moved/deeper/c.txt')
    expect(await fs.readFile(path.join(dir, 'moved/deeper/c.txt'), 'utf8')).toBe('bravo\n')
  })

  it('renames a link as the link', async () => {
    await renameWorkspaceEntry(local, 'rename', 'link', 'relinked')
    expect(await fs.readlink(path.join(dir, 'relinked'))).toBe('a.txt')
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n')
  })

  it('refuses a taken destination, a move into itself, .git, and a way out', async () => {
    expect((await refusal(renameWorkspaceEntry(local, 'rename', 'a.txt', 'd.txt'))).code).toBe('CONFLICT')
    expect((await refusal(renameWorkspaceEntry(local, 'rename', 'moved', 'moved/sub'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorkspaceEntry(local, 'rename', 'a.txt', '.git/hooks/x'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorkspaceEntry(local, 'rename', '.git', 'g'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorkspaceEntry(local, 'rename', 'a.txt', 'away/a.txt'))).code).toBe('VALIDATION')
    expect((await refusal(renameWorkspaceEntry(local, 'rename', 'missing', 'x'))).code).toBe('NOT_FOUND')
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n')
  })
})

describe('deleteWorkspaceEntry', () => {
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
    await deleteWorkspaceEntry(local, 'delete', 'a.txt')
    await expect(fs.stat(path.join(dir, 'a.txt'))).rejects.toThrow()
    await deleteWorkspaceEntry(local, 'delete', 'link')
    await expect(fs.lstat(path.join(dir, 'link'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
  })

  it('deletes a folder recursively, never following a link inside it', async () => {
    await deleteWorkspaceEntry(local, 'delete', 'tree')
    await expect(fs.stat(path.join(dir, 'tree'))).rejects.toThrow()
    await deleteWorkspaceEntry(local, 'delete', 'holder')
    await expect(fs.lstat(path.join(dir, 'holder'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'deep/keep.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a path through a link that leads out, and a missing one', async () => {
    expect((await refusal(deleteWorkspaceEntry(local, 'delete', 'away/secret.txt'))).code).toBe('VALIDATION')
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n')
    expect((await refusal(deleteWorkspaceEntry(local, 'delete', 'missing'))).code).toBe('NOT_FOUND')
  })
})
