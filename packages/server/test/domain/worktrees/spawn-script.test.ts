import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  worktreeBinDir,
  worktreeBinMounts,
  setWorktreeBinDir,
  stageWorktreeBin,
} from '#domain/worktrees/spawn-script'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'yaac-spawn-script-'))
}

afterEach(() => {
  setWorktreeBinDir(null)
})

describe('worktreeBinDir', () => {
  it('defaults to the packaged worktree-bin dir and honors the test override', () => {
    expect(worktreeBinDir().endsWith(path.join('worktree-bin'))).toBe(true)
    setWorktreeBinDir('/elsewhere')
    expect(worktreeBinDir()).toBe('/elsewhere')
    setWorktreeBinDir(null)
    expect(worktreeBinDir().endsWith(path.join('worktree-bin'))).toBe(true)
  })

  it('the shipped dir contains an executable-stageable yaac-spawn and yaac-watch-prs', async () => {
    const names = await stageWorktreeBin(worktreeBinDir(), await makeTmpDir())
    expect(names).toContain('yaac-spawn')
    expect(names).toContain('yaac-watch-prs')
  })
})

describe('stageWorktreeBin', () => {
  it('copies regular files, chmods 0755, and returns sorted names', async () => {
    const src = await makeTmpDir()
    const dest = path.join(await makeTmpDir(), 'bin')
    await fs.writeFile(path.join(src, 'b-tool'), '#!/bin/sh\necho b\n', { mode: 0o644 })
    await fs.writeFile(path.join(src, 'a-tool'), '#!/bin/sh\necho a\n', { mode: 0o600 })
    await fs.writeFile(path.join(src, '.hidden'), 'nope')
    await fs.mkdir(path.join(src, 'subdir'))

    const names = await stageWorktreeBin(src, dest)
    expect(names).toEqual(['a-tool', 'b-tool'])
    for (const name of names) {
      const stat = await fs.stat(path.join(dest, name))
      expect(stat.mode & 0o777).toBe(0o755)
    }
    await expect(fs.access(path.join(dest, '.hidden'))).rejects.toThrow()
  })

  it('replaces a prior staging wholesale', async () => {
    const src = await makeTmpDir()
    const dest = path.join(await makeTmpDir(), 'bin')
    await fs.writeFile(path.join(src, 'old'), 'x')
    await stageWorktreeBin(src, dest)
    await fs.rm(path.join(src, 'old'))
    await fs.writeFile(path.join(src, 'new'), 'y')
    expect(await stageWorktreeBin(src, dest)).toEqual(['new'])
    await expect(fs.access(path.join(dest, 'old'))).rejects.toThrow()
  })

  it('returns [] for a missing source dir (stripped build) without creating dest', async () => {
    const dest = path.join(await makeTmpDir(), 'bin')
    expect(await stageWorktreeBin('/does/not/exist', dest)).toEqual([])
    await expect(fs.access(dest)).rejects.toThrow()
  })
})

describe('worktreeBinMounts', () => {
  it('File-mounts each staged script read-only onto /usr/local/bin', () => {
    expect(worktreeBinMounts('/staging', ['yaac-spawn'])).toEqual([{
      source: { kind: 'hostPath', path: path.join('/staging', 'yaac-spawn'), type: 'File' },
      mountPath: '/usr/local/bin/yaac-spawn',
      readOnly: true,
    }])
    expect(worktreeBinMounts('/staging', [])).toEqual([])
  })
})
