import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testTmpBase, e2eMkdtemp, setHermeticScratch, removeScratchTree } from '#tmp'

// unit-setup has already set hermetic mode. Each case sets the mode it
// checks, and the hook restores the default.
afterEach(() => {
  vi.unstubAllEnvs()
  setHermeticScratch(true)
})

describe('testTmpBase', () => {
  it('is the OS tmpdir for a hermetic (unit) run', () => {
    setHermeticScratch(true)
    vi.stubEnv('YAAC_DATA_DIR', undefined)
    expect(testTmpBase()).toBe(os.tmpdir())
  })

  it('stays the OS tmpdir for a hermetic run even with a custom data dir', () => {
    // Unit tests are timestamp-sensitive, so they avoid YAAC_DATA_DIR,
    // which may be on a virtiofs/network filesystem.
    setHermeticScratch(true)
    vi.stubEnv('YAAC_DATA_DIR', '/srv/yaac-data')
    expect(testTmpBase()).toBe(os.tmpdir())
  })

  it('hangs off the default data dir for a pod-facing (api/e2e) run', () => {
    // `yaac cluster check` proves the data dir is visible to the node;
    // os.tmpdir() has no such guarantee.
    setHermeticScratch(false)
    vi.stubEnv('YAAC_DATA_DIR', undefined)
    expect(testTmpBase()).toBe(path.join(os.homedir(), '.yaac', 'e2e-tmp'))
  })

  it('follows YAAC_DATA_DIR for a pod-facing run (the nested-session case)', () => {
    // In a nested yaac, /tmp and $HOME are invisible to the node, while
    // $YAAC_DATA_DIR is mounted at the same path on both sides.
    setHermeticScratch(false)
    vi.stubEnv('YAAC_DATA_DIR', '/Users/ben/.yaac/nested')
    expect(testTmpBase()).toBe('/Users/ben/.yaac/nested/e2e-tmp')
  })
})

describe('e2eMkdtemp', () => {
  it('creates a unique dir under the temp base with the given prefix', async () => {
    setHermeticScratch(true)
    const dir = await e2eMkdtemp('yaac-tmp-helper-test-')
    try {
      expect(path.dirname(dir)).toBe(testTmpBase())
      expect(path.basename(dir)).toMatch(/^yaac-tmp-helper-test-/)
      await expect(fs.stat(dir)).resolves.toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the base directory when it does not exist yet', async () => {
    // The pod-facing base (<data dir>/e2e-tmp) usually will not exist on a
    // fresh install, unlike the OS tmpdir.
    setHermeticScratch(false)
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmp-base-test-'))
    vi.stubEnv('YAAC_DATA_DIR', path.join(base, 'data'))
    try {
      const dir = await e2eMkdtemp('yaac-tmp-helper-test-')
      expect(path.dirname(dir)).toBe(path.join(base, 'data', 'e2e-tmp'))
      await expect(fs.stat(dir)).resolves.toBeDefined()
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

describe('removeScratchTree', () => {
  it('removes an ordinary tree and reports nothing stuck', async () => {
    setHermeticScratch(true)
    const dir = await e2eMkdtemp('yaac-rm-plain-')
    await fs.mkdir(path.join(dir, 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(dir, 'a', 'b', 'f.txt'), 'x')

    expect(await removeScratchTree(dir)).toEqual([])
    await expect(fs.stat(dir)).rejects.toThrow()
  })

  it('salvages what it can and reports an unreadable subtree instead of throwing', async () => {
    // Stands in for the root-owned 0700 libpod/ that e2e runs leave in a
    // workspace. Mode 0 gives the same unreadable dir without root.
    setHermeticScratch(true)
    const dir = await e2eMkdtemp('yaac-rm-stuck-')
    const locked = path.join(dir, 'workspaces', 'wt-1', 'libpod')
    await fs.mkdir(path.join(locked, 'tmp'), { recursive: true })
    await fs.writeFile(path.join(locked, 'tmp', 'pause.pid'), '1')
    const deletable = path.join(dir, 'projects', 'keep.txt')
    await fs.mkdir(path.dirname(deletable), { recursive: true })
    await fs.writeFile(deletable, 'x')
    await fs.chmod(locked, 0o000)

    try {
      const stuck = await removeScratchTree(dir)

      // Reported, not thrown.
      expect(stuck).toEqual([locked])
      // Everything outside the locked subtree is gone.
      await expect(fs.stat(deletable)).rejects.toThrow()
      await expect(fs.stat(path.join(dir, 'projects'))).rejects.toThrow()
      // The locked dir survives, still holding its contents.
      await expect(fs.stat(locked)).resolves.toBeDefined()
    } finally {
      await fs.chmod(locked, 0o700).catch(() => {})
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('still retries a transient ENOTEMPTY rather than giving up', async () => {
    // A terminating pod writing into a just-emptied dir is a transient race,
    // not a permission problem.
    setHermeticScratch(true)
    const dir = await e2eMkdtemp('yaac-rm-race-')
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
    const real = fs.rm.bind(fs)
    let calls = 0
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (p, opts) => {
      if (++calls === 1) {
        const err = new Error('ENOTEMPTY') as NodeJS.ErrnoException
        err.code = 'ENOTEMPTY'
        throw err
      }
      return real(p, opts)
    })

    try {
      expect(await removeScratchTree(dir)).toEqual([])
      expect(calls).toBeGreaterThan(1)
    } finally {
      spy.mockRestore()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
