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
  projectConfigDir,
  cachedPackagesDir,
  claudeDir,
  projectClaudeCredentialsFile,
  codexDir,
  projectCodexAuthFile,
  codexTranscriptDir,
  codexTranscriptFile,
  opencodeConfigDir,
  worktreesDir,
  worktreeDir,
  proxySecretsCredentialsPath,
  ensureDataDir,
  PACKAGE_ROOT,
  DOCKERFILES_DIR,
  PROXY_DIR,
} from '#project-paths'
import { serverLogPath, expandTilde } from '#paths'

describe('expandTilde', () => {
  it('expands a leading ~', () => {
    const expanded = expandTilde('~/foo')
    expect(expanded.startsWith('/')).toBe(true)
    expect(expanded.endsWith('/foo')).toBe(true)
  })

  it('leaves non-tilde paths alone', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path')
  })
})

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

  it('returns correct server log path', () => {
    setDataDir('/tmp/yaac-test')
    expect(serverLogPath()).toBe('/tmp/yaac-test/server.log')
  })

  it('returns correct project subdirectories', () => {
    setDataDir('/tmp/yaac-test')
    expect(projectDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo')
    expect(repoDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/repo')
    expect(projectConfigDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/config')
    expect(claudeDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/claude')
    expect(projectClaudeCredentialsFile('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/claude/.credentials.json')
    expect(codexDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/codex')
    expect(projectCodexAuthFile('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/codex/auth.json')
    expect(cachedPackagesDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/.cached-packages')
    expect(codexTranscriptDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/codex/.yaac-transcripts')
    expect(codexTranscriptFile('my-repo', 'abc123')).toBe('/tmp/yaac-test/projects/my-repo/codex/.yaac-transcripts/abc123.jsonl')
    expect(opencodeConfigDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/opencode-config')
    expect(worktreesDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/worktrees')
    expect(worktreeDir('my-repo', 'abc123')).toBe('/tmp/yaac-test/projects/my-repo/worktrees/abc123')
  })

  it('returns correct proxy-secrets credentials path', () => {
    setDataDir('/tmp/yaac-test')
    expect(proxySecretsCredentialsPath()).toBe('/tmp/yaac-test/.credentials/proxy-secrets.json')
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

  it('DOCKERFILES_DIR contains Dockerfile.default', async () => {
    const dockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
    const stat = await fs.stat(dockerfile)
    expect(stat.isFile()).toBe(true)
  })

  it('PROXY_DIR contains proxy.ts', async () => {
    const proxyScript = path.join(PROXY_DIR, 'proxy.ts')
    const stat = await fs.stat(proxyScript)
    expect(stat.isFile()).toBe(true)
  })
})
