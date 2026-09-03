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
  opencodeConfigDir,
  worktreesDir,
  worktreeDir,
  secretKeyPath,
  ensureDataDir,
  PACKAGE_ROOT,
  DOCKERFILES_DIR,
  PROXY_DIR,
  NETD_DIR,
  CALICO_DIR,
  calicoManifestCachePath,
  sharedRoot,
  nodeLocalRoot,
  serverLocalRoot,
  clientLocalRoot,
  clientLocalPath,
  proxyDataHostDir,
  sharedPath,
  sharedProjectPath,
  nodeLocalProjectPath,
  serverLocalPath,
  nodeLocalWorktreeStateDir,
  worktreeStateRoots,
  projectWorktreeStateRoots,
  projectRoots,
  projectsRoots,
  worktreeStateDir,
  opencodeDataDir,
  cacheVolumeDir,
} from '#project-paths'
import { serverLogPath, expandTilde, findRepoRoot } from '#paths'

describe('findRepoRoot', () => {
  const here = path.dirname(new URL(import.meta.url).pathname)

  it('walks up past per-package package.json files to the workspace marker', async () => {
    // Every packages/* dir has a package.json; only the repo
    // root has pnpm-workspace.yaml — the walk must not stop early.
    const root = findRepoRoot(here)
    expect(root).toBe(path.resolve(here, '..', '..', '..'))
    const stat = await fs.stat(path.join(root, 'pnpm-workspace.yaml'))
    expect(stat.isFile()).toBe(true)
  })

  it('is a fixed point when starting at the root itself', () => {
    const root = findRepoRoot(here)
    expect(findRepoRoot(root)).toBe(root)
  })

  it('throws when no workspace marker exists up the tree', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-reporoot-'))
    try {
      expect(() => findRepoRoot(tmpDir)).toThrow('pnpm-workspace.yaml')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

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
    expect(opencodeConfigDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/opencode-config')
    expect(worktreesDir('my-repo')).toBe('/tmp/yaac-test/projects/my-repo/worktrees')
    expect(worktreeDir('my-repo', 'abc123')).toBe('/tmp/yaac-test/projects/my-repo/worktrees/abc123')
  })

  it('puts the secret key in the server-local tier, not beside the credentials', () => {
    setDataDir('/tmp/yaac-test')
    // Deliberately NOT under .credentials: that directory is mounted into
    // the proxy pod, and a key beside the ciphertext it opens is no key.
    expect(secretKeyPath()).toBe('/tmp/yaac-test/secret.key')
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

  it('NETD_DIR contains netd.ts', async () => {
    const netdScript = path.join(NETD_DIR, 'netd.ts')
    const stat = await fs.stat(netdScript)
    expect(stat.isFile()).toBe(true)
  })

  it('CALICO_DIR holds the checksum pin, not the manifest itself', async () => {
    const pin = await fs.readFile(path.join(CALICO_DIR, 'calico.yaml.sha256'), 'utf8')
    expect(pin.trim()).toMatch(/^[0-9a-f]{64}\b/)
    await expect(fs.stat(path.join(CALICO_DIR, 'calico.yaml'))).rejects.toThrow()
  })
})

describe('storage tiers', () => {
  afterEach(() => {
    setDataDir('/tmp/yaac-path-test')
  })

  it('resolves the three in-install roots to the one data dir (single-node backend)', () => {
    setDataDir('/tmp/yaac-test')
    expect(sharedRoot()).toBe('/tmp/yaac-test')
    expect(nodeLocalRoot()).toBe('/tmp/yaac-test')
    expect(serverLocalRoot()).toBe('/tmp/yaac-test')
  })

  it('puts the client-local root beside the data dir, never inside it', () => {
    // Beside, because the k8s server is a pod that mounts the data dir:
    // anything under it is reachable by something that is not a client, and
    // an install's clients still have to stay isolated per data dir.
    setDataDir('/tmp/yaac-test')
    expect(clientLocalRoot()).toBe('/tmp/yaac-test-client')
    expect(clientLocalPath('remote.json')).toBe('/tmp/yaac-test-client/remote.json')
    setDataDir('/tmp/other-install')
    expect(clientLocalRoot()).toBe('/tmp/other-install-client')
  })

  it('joins per tier', () => {
    setDataDir('/tmp/yaac-test')
    expect(sharedPath('.credentials')).toBe('/tmp/yaac-test/.credentials')
    expect(proxyDataHostDir()).toBe('/tmp/yaac-test/run/proxy-data')
    expect(sharedProjectPath('my-repo', 'repo')).toBe('/tmp/yaac-test/projects/my-repo/repo')
    expect(nodeLocalProjectPath('my-repo', 'opencode-data', 'abc123'))
      .toBe('/tmp/yaac-test/projects/my-repo/opencode-data/abc123')
    expect(serverLocalPath('db')).toBe('/tmp/yaac-test/db')
  })

  // The node-local tier is where a re-rooting would show up first, and the
  // paths below are also what a session pod mounts today — freeze them so
  // classifying a dir can never move it by accident.
  it('keeps node-local session paths where the single-node backend puts them', () => {
    setDataDir('/tmp/yaac-test')
    const proj = '/tmp/yaac-test/projects/my-repo'
    expect(cachedPackagesDir('my-repo')).toBe(`${proj}/.cached-packages`)
    expect(opencodeDataDir('my-repo', 'abc123')).toBe(`${proj}/opencode-data/abc123`)
    expect(nodeLocalWorktreeStateDir('my-repo', 'abc123')).toBe(`${proj}/sessions/abc123`)
  })

  it('pairs both roots for whole-session, whole-project, and all-project sweeps', () => {
    setDataDir('/tmp/yaac-test')
    // One entry each while the tiers coincide — the dedup is what keeps
    // cleanup from rm-ing (and the GC from reading) the same dir twice.
    expect(worktreeStateRoots('my-repo', 'abc123'))
      .toEqual(['/tmp/yaac-test/projects/my-repo/sessions/abc123'])
    expect(projectWorktreeStateRoots('my-repo')).toEqual(['/tmp/yaac-test/projects/my-repo/sessions'])
    expect(projectRoots('my-repo')).toEqual(['/tmp/yaac-test/projects/my-repo'])
    expect(projectsRoots()).toEqual(['/tmp/yaac-test/projects'])
  })

  it('keeps the shared half of a session dir beside the node-local half', () => {
    setDataDir('/tmp/yaac-test')
    const sess = '/tmp/yaac-test/projects/my-repo/sessions/abc123'
    expect(worktreeStateDir('my-repo', 'abc123')).toBe(sess)
    expect(cacheVolumeDir('my-repo', 'pnpm')).toBe('/tmp/yaac-test/projects/my-repo/cache-volumes/pnpm')
  })
})

describe('calicoManifestCachePath', () => {
  afterEach(() => {
    setDataDir('/tmp/yaac-path-test')
  })

  it('keys the cached manifest by version, in the client-local root', () => {
    // Only `yaac cluster install` ever reads it — standing a CNI up is
    // substrate administration, which no server runs.
    setDataDir('/tmp/yaac-test')
    expect(calicoManifestCachePath('3.32.1')).toBe('/tmp/yaac-test-client/cache/calico-3.32.1.yaml')
    expect(calicoManifestCachePath('3.33.0')).toBe('/tmp/yaac-test-client/cache/calico-3.33.0.yaml')
  })
})
