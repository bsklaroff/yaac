import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  workspaceBinDir,
  workspaceBinMounts,
  setWorkspaceBinDir,
  stageWorkspaceBin,
} from '#domain/workspaces/workspace-bin'

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'yaac-workspace-bin-'))
}

afterEach(() => {
  setWorkspaceBinDir(null)
})

describe('workspaceBinDir', () => {
  it('defaults to the packaged workspace-bin dir and honors the test override', () => {
    expect(workspaceBinDir().endsWith(path.join('workspace-bin'))).toBe(true)
    setWorkspaceBinDir('/elsewhere')
    expect(workspaceBinDir()).toBe('/elsewhere')
    setWorkspaceBinDir(null)
    expect(workspaceBinDir().endsWith(path.join('workspace-bin'))).toBe(true)
  })

  it('the shipped dir contains an executable-stageable yaac-mama and yaac-watch-prs', async () => {
    const names = await stageWorkspaceBin(workspaceBinDir(), await makeTmpDir())
    expect(names).toContain('yaac-mama')
    expect(names).toContain('yaac-watch-prs')
  })
})

describe('stageWorkspaceBin', () => {
  it('copies regular files, chmods 0755, and returns sorted names', async () => {
    const src = await makeTmpDir()
    const dest = path.join(await makeTmpDir(), 'bin')
    await fs.writeFile(path.join(src, 'b-tool'), '#!/bin/sh\necho b\n', { mode: 0o644 })
    await fs.writeFile(path.join(src, 'a-tool'), '#!/bin/sh\necho a\n', { mode: 0o600 })
    await fs.writeFile(path.join(src, '.hidden'), 'nope')
    await fs.mkdir(path.join(src, 'subdir'))

    const names = await stageWorkspaceBin(src, dest)
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
    await stageWorkspaceBin(src, dest)
    await fs.rm(path.join(src, 'old'))
    await fs.writeFile(path.join(src, 'new'), 'y')
    expect(await stageWorkspaceBin(src, dest)).toEqual(['new'])
    await expect(fs.access(path.join(dest, 'old'))).rejects.toThrow()
  })

  it('returns [] for a missing source dir (stripped build) without creating dest', async () => {
    const dest = path.join(await makeTmpDir(), 'bin')
    expect(await stageWorkspaceBin('/does/not/exist', dest)).toEqual([])
    await expect(fs.access(dest)).rejects.toThrow()
  })
})

describe('workspaceBinMounts', () => {
  it('File-mounts each staged script read-only onto /usr/local/bin', () => {
    expect(workspaceBinMounts('/staging', ['yaac-mama'])).toEqual([{
      source: { kind: 'hostPath', path: path.join('/staging', 'yaac-mama'), type: 'File' },
      mountPath: '/usr/local/bin/yaac-mama',
      readOnly: true,
    }])
    expect(workspaceBinMounts('/staging', [])).toEqual([])
  })
})
