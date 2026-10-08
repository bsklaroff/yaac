import { describe, it, expect, afterEach, vi } from 'vitest'
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
  workspacesDir,
  workspaceDir,
  secretKeyPath,
  ensureDataDir,
  PACKAGE_ROOT,
  DOCKERFILES_DIR,
  PROXY_DIR,
  NETD_DIR,
  CALICO_DIR,
  TAILSCALE_OPERATOR_DIR,
  pinnedManifestCachePath,
  globalRoot,
  nodeLocalRoot,
  serverLocalRoot,
  clientLocalRoot,
  clientLocalPath,
  credentialsDir,
  globalPath,
  globalProjectPath,
  nodeLocalProjectPath,
  serverLocalPath,
  workspaceStateDir,
  opencodeDataDir,
  cacheVolumeDir,
  imageStoreDir,
} from '#project-paths'
import { installTmpDir, serverLogPath, expandTilde, findRepoRoot } from '#paths'

/** A project id, as the node-local tier is keyed by. */
const PROJECT_ID = '0b6c1f4e-8a2d-4c3b-9e7f-5d1a2b3c4d5e'

describe('findRepoRoot', () => {
  const here = path.dirname(new URL(import.meta.url).pathname)

  it('walks up past per-package package.json files to the workspace marker', async () => {
    // Every packages/* dir has a package.json; only the repo root has
    // pnpm-workspace.yaml, so the walk must not stop early.
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
    expect(getProjectsDir()).toBe('/tmp/yaac-test/global/projects')
  })

  it('returns correct server log path', () => {
    setDataDir('/tmp/yaac-test')
    expect(serverLogPath()).toBe('/tmp/yaac-test/server-local/server.log')
  })

  it('returns correct project subdirectories', () => {
    setDataDir('/tmp/yaac-test')
    const proj = '/tmp/yaac-test/global/projects/my-repo'
    expect(projectDir('my-repo')).toBe(proj)
    expect(repoDir('my-repo')).toBe(`${proj}/repo`)
    expect(projectConfigDir('my-repo')).toBe(`${proj}/config`)
    expect(claudeDir('my-repo')).toBe(`${proj}/claude`)
    expect(projectClaudeCredentialsFile('my-repo')).toBe(`${proj}/claude/.credentials.json`)
    expect(codexDir('my-repo')).toBe(`${proj}/codex`)
    expect(projectCodexAuthFile('my-repo')).toBe(`${proj}/codex/auth.json`)
    expect(opencodeConfigDir('my-repo')).toBe(`${proj}/opencode-config`)
    expect(workspacesDir('my-repo')).toBe(`${proj}/workspaces`)
    expect(workspaceDir('my-repo', 'abc123')).toBe(`${proj}/workspaces/abc123`)
  })

  it('puts the secret key in the server-local tier, not beside the credentials', () => {
    setDataDir('/tmp/yaac-test')
    // Not under .credentials: that dir's contents are handed to a runtime
    // whole, and the key must not sit beside the ciphertext.
    expect(secretKeyPath()).toBe('/tmp/yaac-test/server-local/secret.key')
  })

  it('ensureDataDir creates the global project tree and the server-local root, idempotently', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-ensure-test-'))
    setDataDir(tmpDir)
    await ensureDataDir()
    await ensureDataDir()
    expect((await fs.stat(path.join(tmpDir, 'global', 'projects'))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(tmpDir, 'server-local'))).isDirectory()).toBe(true)
    // Not the node-local root: each pod's init container creates it under
    // k8s, and the containerless driver creates what it links.
    await expect(fs.stat(path.join(tmpDir, 'node-local'))).rejects.toThrow()
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

  it('PROXY_DIR contains main.ts', async () => {
    const proxyScript = path.join(PROXY_DIR, 'main.ts')
    const stat = await fs.stat(proxyScript)
    expect(stat.isFile()).toBe(true)
  })

  it('NETD_DIR contains netd.ts', async () => {
    const netdScript = path.join(NETD_DIR, 'netd.ts')
    const stat = await fs.stat(netdScript)
    expect(stat.isFile()).toBe(true)
  })

  it.each([
    ['CALICO_DIR', CALICO_DIR, 'calico.yaml'],
    ['TAILSCALE_OPERATOR_DIR', TAILSCALE_OPERATOR_DIR, 'operator.yaml'],
  ])('%s holds the checksum pin, not the manifest itself', async (_name, dir, manifest) => {
    const pin = await fs.readFile(path.join(dir, `${manifest}.sha256`), 'utf8')
    expect(pin.trim()).toMatch(/^[0-9a-f]{64}\b/)
    await expect(fs.stat(path.join(dir, manifest))).rejects.toThrow()
  })
})

describe('storage tiers', () => {
  afterEach(() => {
    setDataDir('/tmp/yaac-path-test')
    vi.unstubAllEnvs()
  })

  it('resolves the three in-install roots to three folders of the data dir', () => {
    setDataDir('/tmp/yaac-test')
    expect(globalRoot()).toBe('/tmp/yaac-test/global')
    expect(nodeLocalRoot()).toBe('/tmp/yaac-test/node-local')
    expect(serverLocalRoot()).toBe('/tmp/yaac-test/server-local')
  })

  it('re-roots exactly one tier per override variable — the pod\'s mount points', () => {
    setDataDir('/tmp/yaac-test')
    vi.stubEnv('YAAC_GLOBAL_ROOT', '/yaac/global')
    expect(globalRoot()).toBe('/yaac/global')
    expect(getProjectsDir()).toBe('/yaac/global/projects')
    expect(nodeLocalRoot()).toBe('/tmp/yaac-test/node-local')
    expect(serverLocalRoot()).toBe('/tmp/yaac-test/server-local')
    vi.stubEnv('YAAC_SERVER_LOCAL_ROOT', '/yaac/server-local')
    expect(serverLocalPath('db')).toBe('/yaac/server-local/db')
    vi.stubEnv('YAAC_NODE_LOCAL_ROOT', '/yaac/node-local')
    expect(cachedPackagesDir('my-repo')).toBe('/yaac/node-local/projects/my-repo/.cached-packages')
    // The install identity is untouched by any of them.
    expect(getDataDir()).toBe('/tmp/yaac-test')
  })

  it('keys the socket tmp dir on the install identity, not on a tier root', () => {
    // Live containerless workspaces' tmux sockets live under this dir and
    // are found by name, so moving it would lose every one.
    setDataDir('/tmp/yaac-test')
    const before = installTmpDir()
    vi.stubEnv('YAAC_SERVER_LOCAL_ROOT', '/yaac/server-local')
    vi.stubEnv('YAAC_GLOBAL_ROOT', '/yaac/global')
    expect(installTmpDir()).toBe(before)
  })

  it('puts the client-local root beside the data dir, never inside it', () => {
    // Beside the tiers, not under them: the k8s server pod mounts the
    // tiers, and client state must stay out of its reach.
    setDataDir('/tmp/yaac-test')
    expect(clientLocalRoot()).toBe('/tmp/yaac-test-client')
    expect(clientLocalPath('remote.json')).toBe('/tmp/yaac-test-client/remote.json')
    setDataDir('/tmp/other-install')
    expect(clientLocalRoot()).toBe('/tmp/other-install-client')
  })

  it('joins per tier', () => {
    setDataDir('/tmp/yaac-test')
    expect(globalPath('run', 'proxy-data')).toBe('/tmp/yaac-test/global/run/proxy-data')
    // The importer reads the pre-database credential files from here.
    expect(credentialsDir()).toBe('/tmp/yaac-test/server-local/.credentials')
    expect(globalProjectPath('my-repo', 'repo')).toBe('/tmp/yaac-test/global/projects/my-repo/repo')
    expect(nodeLocalProjectPath(PROJECT_ID, 'x')).toBe(`/tmp/yaac-test/node-local/projects/${PROJECT_ID}/x`)
    expect(serverLocalPath('db')).toBe('/tmp/yaac-test/server-local/db')
  })

  // Pinned: workspace pods mount these paths and the layout migration
  // moves them.
  it('puts the node-local caches and working copies under the node-local root, by project id', () => {
    setDataDir('/tmp/yaac-test')
    const node = '/tmp/yaac-test/node-local'
    expect(cachedPackagesDir(PROJECT_ID)).toBe(`${node}/projects/${PROJECT_ID}/.cached-packages`)
    expect(opencodeDataDir(PROJECT_ID, 'abc123')).toBe(`${node}/projects/${PROJECT_ID}/opencode-data/abc123`)
    expect(imageStoreDir(PROJECT_ID)).toBe(`${node}/shared-images/${PROJECT_ID}`)
  })

  it('keeps the per-workspace state dir and the cache volumes global', () => {
    setDataDir('/tmp/yaac-test')
    expect(workspaceStateDir('my-repo', 'abc123')).toBe('/tmp/yaac-test/global/projects/my-repo/sessions/abc123')
    expect(cacheVolumeDir('my-repo', 'pnpm')).toBe('/tmp/yaac-test/global/projects/my-repo/cache-volumes/pnpm')
  })
})

describe('pinnedManifestCachePath', () => {
  afterEach(() => {
    setDataDir('/tmp/yaac-path-test')
  })

  it('keeps the cached manifest in the client-local root', () => {
    // Only `yaac cluster install` reads it; no server installs a manifest.
    setDataDir('/tmp/yaac-test')
    expect(pinnedManifestCachePath('calico-3.32.1.yaml')).toBe('/tmp/yaac-test-client/cache/calico-3.32.1.yaml')
  })
})
