import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateDataDirLayout } from '#data-dir-layout'
import { setDataDir } from '#paths'
import { readLock, writeLock } from '#lock'

/**
 * The one-shot layout migration, driven against real directories. What it
 * proves is the rules docs/legacy-compat-shims.md records for it: every
 * row moves, in order; a partial run is resumable and never leaves a
 * database without its key; an empty destination is absent and a full one
 * is a refusal; and the files that do NOT belong to any tier stay put.
 */

let dir: string
const log = vi.fn<(m: string) => void>()

const at = (...rest: string[]): string => path.join(dir, ...rest)
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

async function file(p: string, content = 'x'): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

/** A data dir as a pre-split server left it: every tier at the root. */
async function seedOldLayout(): Promise<void> {
  await file(at('secret.key'), 'KEY')
  await file(at('.credentials', 'github.json'), '{}')
  await file(at('db', 'pg_wal', '0001'), 'wal')
  await file(at('server.log'), 'log')
  await file(at('build', 'Dockerfile.user'), 'FROM x')
  await file(at('models', 'm.gguf'), 'bin')
  await file(at('projects', 'demo', 'project.json'), '{}')
  await file(at('projects', 'demo', 'repo', 'HEAD'), 'ref')
  await file(at('projects', 'demo', '.cached-packages', 'pnpm-store', 'a'), 'pkg')
  await file(at('projects', 'demo', 'opencode-data', 'wt-1', 'opencode.db'), 'sqlite')
  await file(at('projects', 'other', 'project.json'), '{}')
  await file(at('run', 'proxy-data', 'ca.pem'), 'CERT')
  await file(at('run', 'ssh-pub', 'abc.pub'), 'ssh-ed25519 ...')
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-layout-'))
  setDataDir(dir)
  log.mockReset()
})

afterEach(async () => {
  setDataDir('')
  await fs.rm(dir, { recursive: true, force: true })
})

describe('migrateDataDirLayout', () => {
  it('moves every row into its tier folder, in table order, and leaves the root bare', async () => {
    await seedOldLayout()
    await file(at('e2e-tmp', 'scratch'), '')
    await file(at('remote.json'), '{}')
    await file(at('.auth-daemon.lock'), '{}')
    await file(at('driver'), 'k8s\n')

    await migrateDataDirLayout(log)

    expect(await fs.readFile(at('server-local', 'secret.key'), 'utf8')).toBe('KEY')
    expect(await exists(at('server-local', '.credentials', 'github.json'))).toBe(true)
    expect(await exists(at('server-local', 'db', 'pg_wal', '0001'))).toBe(true)
    expect(await exists(at('server-local', 'server.log'))).toBe(true)
    expect(await exists(at('server-local', 'build', 'Dockerfile.user'))).toBe(true)
    expect(await exists(at('server-local', 'models', 'm.gguf'))).toBe(true)
    expect(await exists(at('global', 'projects', 'demo', 'repo', 'HEAD'))).toBe(true)
    expect(await exists(at('global', 'projects', 'other', 'project.json'))).toBe(true)
    expect(await exists(at('global', 'run', 'proxy-data', 'ca.pem'))).toBe(true)
    // NODE-LOCAL, per slug, out of the moved projects tree.
    expect(await exists(at('node-local', 'projects', 'demo', '.cached-packages', 'pnpm-store', 'a'))).toBe(true)
    expect(await exists(at('global', 'projects', 'demo', '.cached-packages'))).toBe(false)
    // The opencode database stays inside the projects tree: that location
    // IS the global checkpoint, so a pre-existing one is a checkpoint
    // already (docs/legacy-compat-shims.md).
    expect(await exists(at('global', 'projects', 'demo', 'opencode-data', 'wt-1', 'opencode.db'))).toBe(true)
    // `run/` held nothing else of ours; the public-key files regenerate.
    expect(await exists(at('run'))).toBe(false)

    // Nothing at the root but the three tiers, the harness's scratch, and
    // the pre-client-local files their fallback readers still look for.
    expect((await fs.readdir(dir)).sort()).toEqual([
      '.auth-daemon.lock', 'driver', 'e2e-tmp', 'global', 'node-local', 'remote.json', 'server-local',
    ])

    // The key first, then the database, and the log names each move.
    const moves = log.mock.calls.map(([m]) => m).filter((m) => m.startsWith('[layout] moved'))
    const rowOf = (name: string): number => moves.findIndex((m) => m.includes(`/${name} ->`))
    expect(rowOf('secret.key')).toBe(0)
    expect(rowOf('.credentials')).toBeLessThan(rowOf('db'))
    expect(rowOf('.credentials')).toBeLessThan(rowOf('projects'))
    expect(rowOf('projects')).toBeLessThan(rowOf('.cached-packages'))
  })

  it('is idempotent, and a no-op on a fresh data dir', async () => {
    await migrateDataDirLayout(log)
    expect(log).not.toHaveBeenCalled()
    expect(await fs.readdir(dir)).toEqual([])

    await seedOldLayout()
    await migrateDataDirLayout(log)
    log.mockReset()
    await migrateDataDirLayout(log)
    expect(log).not.toHaveBeenCalled()
    expect(await exists(at('global', 'projects', 'demo', 'project.json'))).toBe(true)
  })

  it('treats an empty destination as absent, so an ensureDataDir that ran first cannot shadow the move', async () => {
    await seedOldLayout()
    await fs.mkdir(at('global', 'projects'), { recursive: true })
    await fs.mkdir(at('server-local'), { recursive: true })

    await migrateDataDirLayout(log)

    expect(await exists(at('global', 'projects', 'demo', 'project.json'))).toBe(true)
    expect(await exists(at('projects'))).toBe(false)
  })

  it('refuses a non-empty destination beside a still-present source, naming both', async () => {
    await seedOldLayout()
    await file(at('global', 'projects', 'newer', 'project.json'), '{}')

    await expect(migrateDataDirLayout(log)).rejects.toThrow(/cannot move .*\/projects to .*\/global\/projects/)
    // Every row before it landed; the refusal is at the row, not before.
    expect(await exists(at('server-local', 'db'))).toBe(true)
    expect(await exists(at('projects', 'demo', 'project.json'))).toBe(true)
    expect(await exists(at('global', 'projects', 'newer', 'project.json'))).toBe(true)
  })

  it('merges the old log ahead of lines the migrating command already wrote', async () => {
    await seedOldLayout()
    // The command running the migration logs through serverLog, whose
    // file is already the new path — the very thing a rename would refuse.
    await file(at('server-local', 'server.log'), 'new-line\n')
    await migrateDataDirLayout(log)
    expect(await fs.readFile(at('server-local', 'server.log'), 'utf8')).toBe('lognew-line\n')
    expect(await exists(at('server.log'))).toBe(false)
    expect(log.mock.calls.map(([m]) => m).some((m) => m.includes('merged') && m.includes('server.log'))).toBe(true)
  })

  it('refuses while a pre-split server still holds the data dir, and moves nothing', async () => {
    await seedOldLayout()
    // A live lock at the OLD path: this process's pid, and /health answers.
    await file(at('.server.lock'), JSON.stringify({
      pid: process.pid, port: 1, secret: 's', startedAt: Date.now(), buildId: 'b',
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))))
    try {
      await expect(migrateDataDirLayout(log)).rejects.toThrow(/still running.*yaac server stop/s)
      expect(await exists(at('projects', 'demo', 'project.json'))).toBe(true)
      expect(await exists(at('db'))).toBe(true)
      expect(await exists(at('.server.lock'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('unlinks a stale pre-split lock and never moves it', async () => {
    await seedOldLayout()
    await file(at('.server.lock'), JSON.stringify({
      pid: 2 ** 30, port: 1, secret: 's', startedAt: 1, buildId: 'b',
    }))

    await migrateDataDirLayout(log)

    expect(await exists(at('.server.lock'))).toBe(false)
    expect(await exists(at('server-local', '.server.lock'))).toBe(false)
    expect(await readLock()).toBeNull()
    // A server that starts afterwards writes its own at the new path, and
    // that is what a read finds.
    await writeLock({ pid: 1, port: 2, secret: 's', startedAt: 3, buildId: 'b' })
    expect(await exists(at('server-local', '.server.lock'))).toBe(true)
  })

  it('resumes after an interrupted run, with the key already beside the database', async () => {
    await seedOldLayout()
    // Simulate a run that died after row 3: rename fails on `build/`.
    const realRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/build')) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      await realRename(from, to)
    })
    try {
      await expect(migrateDataDirLayout(log)).rejects.toThrow(/could not move .*\/build/)
    } finally {
      spy.mockRestore()
    }
    // The state the abort leaves is not corrupt: the key moved before the
    // database, and both are where the next server looks.
    expect(await exists(at('server-local', 'secret.key'))).toBe(true)
    expect(await exists(at('server-local', 'db'))).toBe(true)
    expect(await exists(at('build'))).toBe(true)
    expect(await exists(at('projects'))).toBe(true)

    // The next call resumes at the first row whose source still exists.
    log.mockReset()
    await migrateDataDirLayout(log)
    expect(await exists(at('server-local', 'build', 'Dockerfile.user'))).toBe(true)
    expect(await exists(at('global', 'projects', 'demo', 'project.json'))).toBe(true)
    const moves = log.mock.calls.map(([m]) => m)
    expect(moves.some((m) => m.includes('/secret.key ->'))).toBe(false)
    expect(moves.some((m) => m.includes('/build ->'))).toBe(true)
  })

  it('moves the old image store when it can, and says what to run when it cannot', async () => {
    await file(at('shared-images', 'demo', 'gen-1', '.yaac-store-done'), '')
    await migrateDataDirLayout(log)
    expect(await exists(at('node-local', 'shared-images', 'demo', 'gen-1', '.yaac-store-done'))).toBe(true)

    // A root-owned store refuses the rename; it is a re-derivable cache,
    // so the migration prints the removal rather than failing the start.
    await file(at('shared-images', 'demo', 'gen-2', '.yaac-store-done'), '')
    const spy = vi.spyOn(fs, 'rename').mockImplementation(() =>
      Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })))
    try {
      log.mockReset()
      await migrateDataDirLayout(log)
    } finally {
      spy.mockRestore()
    }
    expect(log.mock.calls.map(([m]) => m).join('\n')).toMatch(/sudo rm -rf .*\/shared-images/)
    expect(await exists(at('shared-images', 'demo', 'gen-2'))).toBe(true)
  })

  it('does nothing when the data dir does not exist yet', async () => {
    setDataDir(path.join(dir, 'never-made'))
    await expect(migrateDataDirLayout(log)).resolves.toBeUndefined()
    expect(await exists(path.join(dir, 'never-made'))).toBe(false)
  })
})
