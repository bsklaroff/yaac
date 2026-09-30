import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type * as nodeFs from 'node:fs'
import * as confinedFs from '#lib/confined-fs'
import { openExactDir, openRoot, type ConfinedPathError } from '#lib/confined-fs'

type ConfinedFs = typeof confinedFs

/**
 * A real tree with what a sandbox could plant: links inside and outside the
 * root, a dangling link, a FIFO, a socket and a huge sparse file. Every case
 * runs twice: with `/proc/self/fd` (Linux) and without it (as on macOS).
 */

let tmp: string
let root: string
let outside: string
let server: net.Server

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-confined-'))
  root = path.join(tmp, 'root')
  outside = path.join(tmp, 'outside')
  await fs.mkdir(path.join(root, 'sub'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  await fs.writeFile(path.join(root, 'a.txt'), 'alpha')
  await fs.writeFile(path.join(root, 'sub', 'f.txt'), 'in sub')
  await fs.symlink('a.txt', path.join(root, 'in-link'))
  await fs.symlink('sub', path.join(root, 'dir-link'))
  await fs.symlink('../outside/secret.txt', path.join(root, 'out-link'))
  await fs.symlink('../outside', path.join(root, 'out-dir'))
  await fs.symlink('nowhere', path.join(root, 'dangling'))
  await promisify(execFile)('mkfifo', [path.join(root, 'fifo')])
  server = net.createServer()
  await new Promise<void>((resolve) => server.listen(path.join(root, 'sock'), resolve))
  const sparse = await fs.open(path.join(root, 'sparse'), 'w')
  await sparse.truncate(4 * 1024 ** 3)
  await sparse.close()
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(tmp, { recursive: true, force: true })
})

/** A scratch copy of a subtree, for the cases that write. */
async function scratch(name: string): Promise<string> {
  const dir = path.join(tmp, name)
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
  await fs.symlink(path.relative(dir, outside), path.join(dir, 'out-dir'))
  await fs.symlink('sub', path.join(dir, 'dir-link'))
  return dir
}

const text = async (b: Promise<Buffer | null>): Promise<string | null> => (await b)?.toString('utf8') ?? null

async function reason(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e)
  // By name: the fallback run re-imports the module, so `instanceof` fails.
  return err instanceof Error && err.name === 'ConfinedPathError' ? (err as ConfinedPathError).reason : `not confined: ${String(err)}`
}

/** The whole contract, against one build of the module. */
function contract(load: () => Promise<ConfinedFs>): void {
  it('follows links only while they land inside, under `inside`', async () => {
    const { openRoot } = await load()
    const r = await openRoot(root, 'inside')
    const read = (rel: string) => text(r.readFile(rel, { maxBytes: 1024 }))
    expect(await read('in-link')).toBe('alpha')
    expect(await read('dir-link/f.txt')).toBe('in sub')
    for (const planted of ['out-link', 'out-dir/secret.txt', 'dangling', 'fifo', 'sock']) {
      expect(await read(planted)).toBeNull()
    }
    expect(await reason(r.open('out-link', 0))).toBe('outside')
    expect((await r.readdir('out-dir')).length).toBe(0)
  })

  it('reaches nothing through any link under `no-links`', async () => {
    const { openRoot } = await load()
    const r = await openRoot(root, 'no-links')
    const read = (rel: string) => text(r.readFile(rel, { maxBytes: 1024 }))
    expect(await read('a.txt')).toBe('alpha')
    expect(await read('sub/f.txt')).toBe('in sub')
    for (const planted of ['in-link', 'dir-link/f.txt', 'out-link', 'dangling', 'fifo', 'sock']) {
      expect(await read(planted)).toBeNull()
    }
    expect(await r.readdir('dir-link')).toEqual([])
    expect(await r.stat('in-link')).toBeNull()
    expect((await r.stat('a.txt'))?.isFile()).toBe(true)
  })

  it('refuses a file past the cap at the cap, however large it claims to be', async () => {
    const { openRoot } = await load()
    const r = await openRoot(root, 'no-links')
    const err = await r.readFile('sparse', { maxBytes: 1024 }).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ reason: 'too-large', size: 4 * 1024 ** 3 })
  })

  it('writes over a planted link without writing through it, and leaves no temp file', async () => {
    const { openRoot } = await load()
    const dir = await scratch(`write-${String(Math.random()).slice(2)}`)
    const target = path.join(outside, 'target.json')
    await fs.writeFile(target, 'keep')
    await fs.symlink(target, path.join(dir, 'settings.json'))
    for (const policy of ['inside', 'no-links'] as const) {
      const r = await openRoot(dir, policy)
      await r.writeAtomic('settings.json', `{"by":"${policy}"}`)
      expect(await fs.readFile(target, 'utf8')).toBe('keep')
      expect((await fs.lstat(path.join(dir, 'settings.json'))).isFile()).toBe(true)
      expect(await reason(r.writeAtomic('out-dir/planted.txt', 'x'))).toBe('outside')
    }
    // A file named like the writer's temp file must not interfere.
    await fs.writeFile(path.join(dir, `.settings.json.${String(process.pid)}.0.tmp`), '')
    await (await openRoot(dir, 'no-links')).writeAtomic('settings.json', 'again')
    expect((await fs.readdir(dir)).sort())
      .toEqual([`.settings.json.${String(process.pid)}.0.tmp`, 'dir-link', 'out-dir', 'settings.json', 'sub'])
    expect(await fs.readdir(outside)).not.toContain('planted.txt')
  })

  it('makes and removes directories only where the policy reaches', async () => {
    const { openRoot } = await load()
    const dir = await scratch(`tree-${String(Math.random()).slice(2)}`)
    const inside = await openRoot(dir, 'inside')
    await inside.mkdirp('dir-link/made/deeper')
    expect((await fs.stat(path.join(dir, 'sub/made/deeper'))).isDirectory()).toBe(true)
    expect(await reason(inside.mkdirp('out-dir/planted'))).toBe('outside')
    expect(await reason((await openRoot(dir, 'no-links')).mkdirp('dir-link/x'))).toBe('outside')

    await fs.writeFile(path.join(dir, 'sub/made/file'), 'f')
    await fs.symlink(outside, path.join(dir, 'sub/made/escape'))
    await inside.removeTree('sub')
    await inside.removeTree('out-dir')
    expect(await fs.readdir(dir)).toEqual(['dir-link'])
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('checks names lexically, and keeps excluded names outside', async () => {
    const { openRoot } = await load()
    const r = await openRoot(root, 'inside', { exclude: ['sub'] })
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\0b', 'sub/f.txt']) {
      expect(await reason(r.open(bad, 0))).toBe('invalid')
    }
    expect(await reason(r.parent(''))).toBe('invalid')
    expect(r.contains(path.join(r.real, 'sub', 'f.txt'))).toBeNull()
    expect(r.contains('pipe:[123]')).toBeNull()
    expect(r.contains(path.join(r.real, 'a.txt'))).toBe('a.txt')
  })

  it('takes paths from a base below a larger root', async () => {
    const { openRoot } = await load()
    const r = await openRoot(tmp, 'inside', { base: root })
    expect(await text(r.readFile('dir-link/f.txt', { maxBytes: 1024 }))).toBe('in sub')
    // Links must stay inside the root, not the base.
    expect(await text(r.readFile('out-link', { maxBytes: 1024 }))).toBe('secret')
  })
}

describe('openRoot', () => {
  describe('with /proc/self/fd', () => {
    contract(() => Promise.resolve(confinedFs))
  })

  it('locks one file whichever way its root and path are spelled', async () => {
    // Two creates open the same tool home separately, so the lock must key
    // on the file itself, not on how a caller named it.
    const link = path.join(tmp, 'root-link')
    await fs.symlink(root, link)
    const handles = [
      await openRoot(root, 'inside'),
      await openRoot(`${link}/`, 'inside'),
      await openRoot(tmp, 'inside', { base: root }),
    ]
    const events: string[] = []
    const task = (name: string) => async (): Promise<void> => {
      events.push(`${name}+`)
      await new Promise((r) => setTimeout(r, 5))
      events.push(`${name}-`)
    }
    await Promise.all([
      handles[0].locked('x.json', task('a')),
      handles[1].locked('./x.json', task('b')),
      handles[2].locked('x.json/', task('c')),
    ])
    expect(events).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
  })

  describe('without /proc/self/fd', () => {
    const load = async (): Promise<ConfinedFs> => {
      vi.resetModules()
      vi.doMock('node:fs', async (importOriginal) => {
        const real = await importOriginal<typeof nodeFs>()
        const existsSync = (p: nodeFs.PathLike): boolean => p !== '/proc/self/fd' && real.existsSync(p)
        return { ...real, default: { ...real, existsSync }, existsSync }
      })
      try {
        // eslint-disable-next-line no-restricted-syntax -- a fresh evaluation under the mock is the point
        return await import('#lib/confined-fs')
      } finally {
        vi.doUnmock('node:fs')
      }
    }

    it('pins by path, having no descriptors to pin by', async () => {
      const top = await (await (await load()).openRoot(root, 'inside')).dir('')
      expect(top.self).toBe(top.real)
    })

    contract(load)
  })
})

describe('openExactDir', () => {
  it('opens a real directory and nothing a link names', async () => {
    const top = await (await openRoot(root, 'inside')).dir('')
    try {
      const sub = await openExactDir(top, 'sub')
      expect(sub?.real).toBe(path.join(top.real, 'sub'))
      await sub?.close()
      for (const name of ['dir-link', 'out-dir', 'a.txt', 'missing']) {
        expect(await openExactDir(top, name)).toBeNull()
      }
    } finally {
      await top.close()
    }
  })
})
