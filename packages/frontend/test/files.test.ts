import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WorktreeFiles } from '@yaac/shared/types'
import {
  FileConflict,
  buildTree,
  fileTabLabels,
  fileTarget,
  fileTargetPath,
  filterPaths,
  isFileTarget,
  isFilesTarget,
  placeFile,
  saveWorktreeFile,
  type TreeNode,
} from '#lib/files'
import { singleColumn, type Workspace } from '#lib/layout'

const listing = (over: Partial<WorktreeFiles> = {}): WorktreeFiles => ({
  paths: [], symlinks: {}, ignored: [], emptyDirs: [], status: {}, truncated: false, ...over,
})

/** A tree as nested names — folders as `name/` with their children. */
function shape(node: TreeNode): unknown {
  return node.children.map((c) => (c.dir && !c.symlink ? { [`${c.name}/`]: shape(c) } : c.name))
}

describe('targets', () => {
  it('names the explorer and one pane per file', () => {
    expect(isFilesTarget('files')).toBe(true)
    expect(fileTarget('src/a.ts')).toBe('file:src/a.ts')
    expect(isFileTarget('file:src/a.ts')).toBe(true)
    expect(isFileTarget('files')).toBe(false)
    expect(fileTargetPath('file:src/a.ts')).toBe('src/a.ts')
  })
})

describe('buildTree', () => {
  it('nests paths into folders, folders first then by name, with empty folders', () => {
    const { root } = buildTree(listing({
      paths: ['z.txt', 'src/b.ts', 'src/a.ts', 'README.md', 'src/lib/c.ts'],
      emptyDirs: ['docs', 'src/empty'],
    }))
    expect(shape(root)).toEqual([
      { 'docs/': [] },
      { 'src/': [{ 'empty/': [] }, { 'lib/': ['c.ts'] }, 'a.ts', 'b.ts'] },
      'README.md',
      'z.txt',
    ])
  })

  it('rolls a folder’s status up from its files, strongest first', () => {
    const { index } = buildTree(listing({
      paths: ['a/x.ts', 'a/y.ts', 'a/b/z.ts', 'c/new.ts', 'd/clean.ts'],
      status: { 'a/x.ts': 'untracked', 'a/y.ts': 'modified', 'a/b/z.ts': 'conflicted', 'c/new.ts': 'untracked' },
    }))
    expect(index.get('a')?.status).toBe('conflicted')
    expect(index.get('a/b')?.status).toBe('conflicted')
    expect(index.get('c')?.status).toBe('untracked')
    expect(index.get('d')?.status).toBeUndefined()
    expect(index.get('a/y.ts')?.status).toBe('modified')
  })

  it('merges ignored entries only when asked, flagged, with wholly ignored folders lazy', () => {
    const files = listing({ paths: ['pkg/keep.ts'], ignored: ['node_modules/', 'pkg/build/', 'debug.log'] })
    expect(shape(buildTree(files).root)).toEqual([{ 'pkg/': ['keep.ts'] }])
    const { root, index } = buildTree(files, true)
    expect(shape(root)).toEqual([
      { 'node_modules/': [] },
      { 'pkg/': [{ 'build/': [] }, 'keep.ts'] },
      'debug.log',
    ])
    expect(index.get('node_modules')).toMatchObject({ ignored: true, lazy: true })
    expect(index.get('pkg/build')).toMatchObject({ ignored: true, lazy: true })
    expect(index.get('debug.log')).toMatchObject({ ignored: true, dir: false })
    expect(index.get('pkg')?.ignored).toBeUndefined()
  })

  it('makes a folder link expandable and leaves file and broken links as files', () => {
    const { index } = buildTree(listing({
      paths: ['lib', 'src/a.ts', 'readme', 'gone'],
      symlinks: {
        lib: { target: 'src', dir: true },
        readme: { target: 'src/a.ts', dir: false },
        gone: { target: null, dir: false },
      },
    }))
    expect(index.get('lib')).toMatchObject({ dir: true, symlink: { target: 'src', dir: true } })
    expect(index.get('readme')).toMatchObject({ dir: false })
    expect(index.get('gone')).toMatchObject({ dir: false, symlink: { target: null } })
  })
})

describe('filterPaths', () => {
  const paths = ['src/components/WorktreeFiles.tsx', 'src/lib/files.ts', 'docs/file-editor.md', 'package.json']

  it('matches a case-insensitive subsequence, best first', () => {
    expect(filterPaths(paths, 'files')[0]).toBe('src/lib/files.ts')
    expect(filterPaths(paths, 'WTF')).toEqual(['src/components/WorktreeFiles.tsx'])
    expect(filterPaths(paths, 'zzz')).toEqual([])
  })

  it('caps the result', () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}.ts`)
    expect(filterPaths(many, 'f', 200)).toHaveLength(200)
  })
})

describe('fileTabLabels', () => {
  it('names each file by its basename, adding just enough parent path to tell two apart', () => {
    expect(fileTabLabels(['src/a/index.ts', 'src/b/index.ts', 'lib/x/util.ts', 'index.ts'])).toEqual({
      'src/a/index.ts': 'index.ts · a',
      'src/b/index.ts': 'index.ts · b',
      'index.ts': 'index.ts',
      'lib/x/util.ts': 'util.ts',
    })
    expect(fileTabLabels(['a/lib/index.ts', 'b/lib/index.ts'])).toEqual({
      'a/lib/index.ts': 'index.ts · a/lib',
      'b/lib/index.ts': 'index.ts · b/lib',
    })
  })
})

describe('placeFile', () => {
  const a = fileTarget('a.ts')
  const b = fileTarget('b.ts')
  const c = fileTarget('c.ts')

  it('leaves a file that is already open where it is', () => {
    const ws: Workspace = [{ tabs: ['agent', a], active: 'agent' }]
    expect(placeFile(ws, a)).toBe(ws)
  })

  it('opens beside the explorer when no file is open, else at the end', () => {
    const withExplorer: Workspace = [
      { tabs: ['agent'], active: 'agent' }, { tabs: ['files'], active: 'files' }, { tabs: ['shell:x'], active: 'shell:x' },
    ]
    expect(placeFile(withExplorer, a).map((g) => g.tabs)).toEqual([['agent'], ['files'], [a], ['shell:x']])
    expect(placeFile(singleColumn('agent'), a).map((g) => g.tabs)).toEqual([['agent'], [a]])
  })

  it('tabs into the column of the active file pane, then of any file pane', () => {
    const ws: Workspace = [
      { tabs: ['agent', a], active: 'agent' },
      { tabs: [b], active: b },
    ]
    expect(placeFile(ws, c, b)[1]).toEqual({ tabs: [b, c], active: c })
    // No active file pane: the first column holding one.
    expect(placeFile(ws, c, 'agent')[0]).toEqual({ tabs: ['agent', a, c], active: c })
  })
})

describe('saveWorktreeFile', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  function stub(json: unknown, status: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(json),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  it('PUTs the text against its base version', async () => {
    const fetchMock = stub({ path: 'a.ts', version: 'v2', size: 1 }, 200)
    expect(await saveWorktreeFile('w1', 'a.ts', 'x', 'v1')).toEqual({ path: 'a.ts', version: 'v2', size: 1 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new URL(url, 'http://localhost').pathname).toBe('/worktree/w1/file')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'a.ts', content: 'x', baseVersion: 'v1' })
  })

  it('surfaces a 409 as a FileConflict naming the version on disk, or none', async () => {
    stub({ error: { code: 'CONFLICT', message: 'changed' }, version: 'v3' }, 409)
    await expect(saveWorktreeFile('w1', 'a.ts', 'x', 'v1')).rejects.toEqual(new FileConflict('v3'))
    stub({ error: { code: 'CONFLICT', message: 'gone' }, version: null }, 409)
    const err = await saveWorktreeFile('w1', 'a.ts', 'x', 'v1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FileConflict)
    expect((err as FileConflict).version).toBeNull()
  })

  it('throws any other failure as the server’s error', async () => {
    stub({ error: { code: 'TOO_LARGE', message: 'too big' } }, 413)
    await expect(saveWorktreeFile('w1', 'a.ts', 'x', 'v1')).rejects.toMatchObject({ code: 'TOO_LARGE', message: 'too big' })
  })
})
