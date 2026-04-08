import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  setDataDir,
  getDataDir,
  getProjectsDir,
  projectDir,
  repoDir,
  claudeDir,
  worktreesDir,
  worktreeDir,
  ensureDataDir,
  PACKAGE_ROOT,
  DOCKERFILES_DIR,
  PROXY_DIR,
} from '@/lib/paths'

describe('paths', () => {
  afterEach(() => {
    // Reset to default
    setDataDir('/tmp/yaac-path-test')
  })

  it('uses custom data dir when set', () => {
    setDataDir('/tmp/yaac-custom')
    expect(getDataDir()).toBe('/tmp/yaac-custom')
  })

  it('returns correct projects dir', () => {
    setDataDir('/tmp/yaac-test')
    expect(getProjectsDir()).toBe('/tmp/yaac-test/projects')
  })

  it('returns correct project subdirectories', () => {
    setDataDir('/tmp/yaac-test')
    expect(projectDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo')
    expect(repoDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/repo')
    expect(claudeDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/claude')
    expect(worktreesDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/worktrees')
    expect(worktreeDir('my-repo', 'abc123')).toBe('/tmp/yaac-test/projects/my-repo/worktrees/abc123')
  })

  it('ensureDataDir creates projects directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ensure-test-'))
    setDataDir(tmpDir)
    await ensureDataDir()
    const stat = await fs.stat(path.join(tmpDir, 'projects'))
    expect(stat.isDirectory()).toBe(true)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('ensureDataDir is idempotent', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ensure-test-'))
    setDataDir(tmpDir)
    await ensureDataDir()
    await ensureDataDir()
    const stat = await fs.stat(path.join(tmpDir, 'projects'))
    expect(stat.isDirectory()).toBe(true)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('PACKAGE_ROOT points to the repo root', async () => {
    const packageJson = path.join(PACKAGE_ROOT, 'package.json')
    const stat = await fs.stat(packageJson)
    expect(stat.isFile()).toBe(true)
  })

  it('DOCKERFILES_DIR contains Dockerfile.base', async () => {
    const dockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.base')
    const stat = await fs.stat(dockerfile)
    expect(stat.isFile()).toBe(true)
  })

  it('PROXY_DIR contains proxy.mjs', async () => {
    const proxyScript = path.join(PROXY_DIR, 'proxy.mjs')
    const stat = await fs.stat(proxyScript)
    expect(stat.isFile()).toBe(true)
  })
})
