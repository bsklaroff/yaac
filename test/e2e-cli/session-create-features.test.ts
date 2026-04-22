import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import { podman } from '@/lib/container/runtime'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman, TEST_RUN_ID, podmanRetry } from '@test/helpers/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@test/helpers/mock-remotes'

/**
 * Feature-by-feature coverage for `yaac session create` driven through
 * the real CLI + real daemon + real podman, replacing the integration-
 * style `test/e2e/session-create.test.ts` which re-implemented container
 * orchestration instead of exercising the product's code path. Uses the
 * same mock-remote harness as `session-create-happy.test.ts`: the proxy
 * rewrites GitHub / Anthropic hostnames to local mock containers so
 * session-create's GitHub-token + credential-injection paths are
 * satisfied without touching the real internet.
 *
 * Deliberately deferred:
 *   - pgRelay — the daemon's pg-relay singleton hardcodes the
 *     `yaac-sessions` network, which doesn't match the test proxy's
 *     network override. The session container and relay would end up on
 *     different networks, so the CLI path can't be exercised without a
 *     product change.
 *   - nestedContainers — skipped in containerized CI already, and a
 *     CLI-driven version would just re-prove the same podman calls.
 *   - pnpm cache reuse — exercises pnpm store behavior, not CLI surface.
 */
describe('yaac session create features (real CLI + real daemon)', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let daemonEnv: NodeJS.ProcessEnv
  let extraVolumes: string[]

  beforeAll(async () => {
    await requirePodman()
    try {
      await podmanRetry(['network', 'create', networkName])
    } catch { /* already exists */ }
  })

  async function seedCredentials(): Promise<void> {
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
    }) + '\n')
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-ant-fake-real-key',
    }) + '\n')
  }

  async function setupProject(
    slug: string,
    opts: {
      yaacConfig?: Record<string, unknown>
      files?: Record<string, string>
    } = {},
  ): Promise<void> {
    const files: Record<string, string> = {
      'README.md': '# demo\n',
      ...(opts.files ?? {}),
    }
    if (opts.yaacConfig) {
      files['yaac-config.json'] = JSON.stringify(opts.yaacConfig, null, 2) + '\n'
    }
    await seedMockGitRepo(mockGit!, slug, { files })

    const projectPath = path.join(testEnv.dataDir, 'projects', slug)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await simpleGit(repoPath).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
      slug,
      remoteUrl: fakeRemote,
      addedAt: new Date().toISOString(),
    }) + '\n')
  }

  async function findContainerName(slug: string): Promise<string> {
    // The daemon starts a background prewarm right after session-create
    // returns — scope by data-dir + project, take the oldest so we
    // always grab the CLI's session, not the freshly-minted prewarm.
    const { stdout } = await podmanRetry([
      'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
      '--filter', `label=yaac.project=${slug}`,
      '--format', '{{.Names}}|{{.CreatedAt}}',
    ])
    const name = stdout
      .split('\n').filter(Boolean)
      .sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
      .map((row) => row.split('|')[0])[0]
    if (!name) throw new Error(`no container found for project ${slug}`)
    return name
  }

  async function createSession(
    slug: string,
    ...extraArgs: string[]
  ): Promise<string> {
    const { stdout, stderr, exitCode } = await runYaac(
      daemonEnv, 'session', 'create', slug, '--tool', 'claude', ...extraArgs,
    )
    if (exitCode !== 0) {
      throw new Error(`session create failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    return findContainerName(slug)
  }

  beforeEach(async () => {
    extraVolumes = []
    testEnv = await createYaacTestEnv()
    await seedCredentials()
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )
    mockLLM = await startMockLLM(networkName)
    mockGit = await startMockGit(networkName)

    const llmTarget = { host: mockLLM.networkIp, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.networkIp, port: mockGit.port, tls: false }
    daemonEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
      // Set once at daemon startup so the envPassthrough test can observe
      // it without needing to restart the daemon. Harmless for other tests.
      YAAC_TEST_VAR: 'hello-from-host',
    }
    daemon = await spawnYaacDaemon(daemonEnv)
  })

  afterEach(async () => {
    if (daemon) await daemon.stop()
    daemon = null
    try {
      const { stdout } = await podmanRetry([
        'ps', '-a', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
        '--format', '{{.Names}}',
      ])
      const names = stdout.split('\n').filter(Boolean)
      if (names.length > 0) await podmanRetry(['rm', '-f', ...names])
    } catch { /* best effort */ }
    for (const vol of extraVolumes) {
      try { await podmanRetry(['volume', 'rm', vol]) } catch { /* already gone */ }
    }
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('provisions container, worktree, mounts, git, and tmux', async () => {
    await setupProject('basics')
    const name = await createSession('basics')

    const info = await podman.getContainer(name).inspect()
    expect(info.State.Running).toBe(true)
    expect(info.Config.Labels['yaac.project']).toBe('basics')
    expect(info.Config.Labels['yaac.tool']).toBe('claude')
    const sessionId = info.Config.Labels['yaac.session-id']
    expect(sessionId).toBeTruthy()

    await podmanRetry(['exec', name, 'test', '-d', '/home/yaac/.claude'])
    await podmanRetry(['exec', name, 'test', '-f', '/home/yaac/.claude.json'])
    await podmanRetry(['exec', name, 'test', '-d', '/home/yaac/.codex'])

    const { stdout: lsOut } = await podmanRetry(['exec', name, 'ls', '/workspace'])
    expect(lsOut).toContain('README.md')

    const { stdout: gitStatus } = await podmanRetry([
      'exec', '-w', '/workspace', name, 'git', 'status', '--porcelain',
    ])
    expect(gitStatus.trim()).toBe('')
    const { stdout: branch } = await podmanRetry([
      'exec', '-w', '/workspace', name, 'git', 'rev-parse', '--abbrev-ref', 'HEAD',
    ])
    expect(branch.trim()).toBe(`yaac/${sessionId}`)

    const { stdout: tmuxList } = await podmanRetry([
      'exec', name, 'tmux', 'list-sessions',
    ])
    expect(tmuxList).toContain('yaac')
    const { stdout: statusRight } = await podmanRetry([
      'exec', name, 'tmux', 'show-option', '-t', 'yaac', 'status-right',
    ])
    expect(statusRight).toContain(sessionId.slice(0, 8))

    await expect(podmanRetry([
      'exec', name, 'test', '-f', '/tmp/yaac-prompt',
    ])).rejects.toThrow()
  }, 90_000)

  it('passes envPassthrough vars to the container', async () => {
    await setupProject('passthrough', {
      yaacConfig: { envPassthrough: ['YAAC_TEST_VAR'] },
    })
    const name = await createSession('passthrough')

    const { stdout } = await podmanRetry(['exec', name, 'env'])
    expect(stdout).toContain('YAAC_TEST_VAR=hello-from-host')
  }, 90_000)

  it('mounts shared Claude and Codex state in Codex sessions', async () => {
    await setupProject('shared-codex')
    const { stdout, stderr, exitCode } = await runYaac(
      daemonEnv, 'session', 'create', 'shared-codex', '--tool', 'codex',
    )
    if (exitCode !== 0) {
      throw new Error(`exit ${exitCode}\nstdout:${stdout}\nstderr:${stderr}`)
    }
    const name = await findContainerName('shared-codex')
    const info = await podman.getContainer(name).inspect()
    expect(info.Config.Labels['yaac.tool']).toBe('codex')

    await podmanRetry(['exec', name, 'test', '-d', '/home/yaac/.claude'])
    await podmanRetry(['exec', name, 'test', '-f', '/home/yaac/.claude.json'])
    await podmanRetry(['exec', name, 'test', '-d', '/home/yaac/.codex'])
  }, 90_000)

  it('mounts named cacheVolumes from config', async () => {
    const volName = 'yaac-cache-cache-vol-test-cache'
    try { await podmanRetry(['volume', 'rm', volName]) } catch { /* not present */ }
    extraVolumes.push(volName)

    await setupProject('cache-vol', {
      yaacConfig: { cacheVolumes: { 'test-cache': '/tmp/test-cache' } },
    })
    const name = await createSession('cache-vol')

    await podmanRetry([
      'exec', name, 'sh', '-c', 'echo hello > /tmp/test-cache/marker',
    ])
    const { stdout } = await podmanRetry([
      'exec', name, 'cat', '/tmp/test-cache/marker',
    ])
    expect(stdout.trim()).toBe('hello')
  }, 90_000)

  it('runs initCommands at session start', async () => {
    await setupProject('init-cmd', {
      // `sleep` keeps the init tmux window alive long enough for the
      // daemon's follow-up `tmux set-option -t yaac:init remain-on-exit`
      // to find the window. A bare `touch` exits before that call and
      // triggers a retry loop in session-create.
      yaacConfig: { initCommands: ['touch /tmp/init-ran && sleep 30'] },
    })
    const name = await createSession('init-cmd')

    // Init commands run in a background tmux window, so poll rather than
    // assume they finished by the time session-create returned.
    let ran = false
    for (let i = 0; i < 40; i++) {
      try {
        await podmanRetry(['exec', name, 'test', '-f', '/tmp/init-ran'])
        ran = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    expect(ran).toBe(true)
  }, 90_000)

  it('forwards configured host ports and surfaces them in tmux status bar', async () => {
    await setupProject('portfwd', {
      yaacConfig: {
        portForward: [
          { containerPort: 8080, hostPortStart: 29080 },
          { containerPort: 3000, hostPortStart: 24000 },
        ],
      },
    })
    const name = await createSession('portfwd')

    // Port forwarding runs through the daemon's `podmanRelay` TCP proxy,
    // not podman's native PortBindings, so the container's HostConfig
    // has no port map — status-right is the user-facing surface for the
    // chosen host ports.
    const { stdout: statusRight } = await podmanRetry([
      'exec', name, 'tmux', 'show-option', '-t', 'yaac', 'status-right',
    ])
    const match8080 = statusRight.match(/:(\d+)->8080/)
    const match3000 = statusRight.match(/:(\d+)->3000/)
    expect(match8080).not.toBeNull()
    expect(match3000).not.toBeNull()
    expect(Number(match8080![1])).toBeGreaterThanOrEqual(29080)
    expect(Number(match3000![1])).toBeGreaterThanOrEqual(24000)
  }, 90_000)

  it('mounts bindMounts read-only and read-write per config mode', async () => {
    const roDir = path.join(testEnv.scratchDir, 'ro-data')
    const rwDir = path.join(testEnv.scratchDir, 'rw-data')
    await fs.mkdir(roDir, { recursive: true })
    await fs.mkdir(rwDir, { recursive: true })
    await fs.writeFile(path.join(roDir, 'readme.txt'), 'read-only content')
    await fs.writeFile(path.join(rwDir, 'data.txt'), 'writable content')

    await setupProject('bindmount', {
      yaacConfig: {
        bindMounts: [
          { hostPath: roDir, containerPath: '/mnt/ro-data', mode: 'ro' },
          { hostPath: rwDir, containerPath: '/mnt/rw-data', mode: 'rw' },
        ],
      },
    })
    const name = await createSession('bindmount')

    const { stdout: roContent } = await podmanRetry([
      'exec', name, 'cat', '/mnt/ro-data/readme.txt',
    ])
    expect(roContent.trim()).toBe('read-only content')
    await expect(podmanRetry([
      'exec', name, 'sh', '-c', 'echo test > /mnt/ro-data/fail.txt',
    ])).rejects.toThrow()

    const { stdout: rwContent } = await podmanRetry([
      'exec', name, 'cat', '/mnt/rw-data/data.txt',
    ])
    expect(rwContent.trim()).toBe('writable content')
    await podmanRetry([
      'exec', name, 'sh', '-c', 'echo new-data > /mnt/rw-data/new.txt',
    ])
    const { stdout: newContent } = await podmanRetry([
      'exec', name, 'cat', '/mnt/rw-data/new.txt',
    ])
    expect(newContent.trim()).toBe('new-data')
  }, 90_000)

  it('redirects /workspace/node_modules through .cached-packages and cleans up on delete', async () => {
    // Real Node projects gitignore node_modules; seed the same so
    // `git status` stays clean once the bind mount is populated.
    await setupProject('ephemeral-modules', {
      files: { '.gitignore': 'node_modules\n' },
    })
    const name = await createSession('ephemeral-modules')

    const info = await podman.getContainer(name).inspect()
    const sessionId = info.Config.Labels['yaac.session-id']
    expect(sessionId).toBeTruthy()

    // Inside the container: /workspace/node_modules is a real directory
    // backed by a bind mount — not a symlink (Node's fs.mkdir would
    // reject a symlink-to-dir with ENOTDIR, breaking pnpm).
    await expect(podmanRetry([
      'exec', name, 'readlink', '/workspace/node_modules',
    ])).rejects.toThrow()
    const { stdout: ftype } = await podmanRetry([
      'exec', name, 'stat', '-c', '%F', '/workspace/node_modules',
    ])
    expect(ftype.trim()).toBe('directory')

    // Write to the bind mount and confirm the bytes land in the
    // host-side .cached-packages tree, NOT in the worktree.
    await podmanRetry([
      'exec', name, 'sh', '-c',
      'echo hello > /workspace/node_modules/marker.txt',
    ])
    const hostBacking = path.join(
      testEnv.dataDir, 'projects', 'ephemeral-modules',
      '.cached-packages', 'modules', sessionId, 'root', 'marker.txt',
    )
    const hostMarker = await fs.readFile(hostBacking, 'utf8')
    expect(hostMarker.trim()).toBe('hello')

    // Host worktree's node_modules has no leaked content — the bind
    // mount shadows it from the container side only.
    const worktreeMarker = path.join(
      testEnv.dataDir, 'projects', 'ephemeral-modules',
      'worktrees', sessionId, 'node_modules', 'marker.txt',
    )
    await expect(fs.access(worktreeMarker)).rejects.toThrow()

    // node_modules is gitignored (via the seeded .gitignore), so a
    // populated bind mount doesn't surface in `git status`.
    const { stdout: gitStatus } = await podmanRetry([
      'exec', '-w', '/workspace', name, 'git', 'status', '--porcelain',
    ])
    expect(gitStatus.trim()).toBe('')

    // Seed the pnpm-store so the post-delete assertion below can verify
    // that modules/<sid> is reaped while the shared store survives.
    await podmanRetry([
      'exec', name, 'sh', '-c',
      'mkdir -p /home/yaac/.cached-packages/pnpm-store && echo store-content > /home/yaac/.cached-packages/pnpm-store/src',
    ])

    // Delete the session; modules/<sid> goes away, pnpm-store survives.
    const { exitCode: delExit } = await runYaac(
      daemonEnv, 'session', 'delete', sessionId,
    )
    expect(delExit).toBe(0)

    const modulesRoot = path.join(
      testEnv.dataDir, 'projects', 'ephemeral-modules',
      '.cached-packages', 'modules', sessionId,
    )
    // Cleanup is detached — poll briefly.
    let gone = false
    for (let i = 0; i < 40; i++) {
      try {
        await fs.access(modulesRoot)
        await new Promise((r) => setTimeout(r, 250))
      } catch {
        gone = true
        break
      }
    }
    expect(gone).toBe(true)

    const pnpmStoreSrc = path.join(
      testEnv.dataDir, 'projects', 'ephemeral-modules',
      '.cached-packages', 'pnpm-store', 'src',
    )
    await expect(fs.access(pnpmStoreSrc)).resolves.toBeUndefined()
  }, 120_000)

  it('disables node_modules redirect when ephemeralModulesPaths is []', async () => {
    await setupProject('no-ephemeral', {
      yaacConfig: { ephemeralModulesPaths: [] },
    })
    const name = await createSession('no-ephemeral')

    // /workspace/node_modules should not exist at all when the feature
    // is disabled — the worktree is a fresh git checkout with no
    // node_modules in it and no bind mount is installed.
    await expect(podmanRetry([
      'exec', name, 'test', '-e', '/workspace/node_modules',
    ])).rejects.toThrow()
  }, 90_000)

  it('--add-dir mounts read-only, --add-dir-rw mounts read-write', async () => {
    const roDir = path.join(testEnv.scratchDir, 'ro-extra')
    const rwDir = path.join(testEnv.scratchDir, 'rw-extra')
    await fs.mkdir(roDir, { recursive: true })
    await fs.mkdir(rwDir, { recursive: true })
    await fs.writeFile(path.join(roDir, 'hello.txt'), 'read-only extra')
    await fs.writeFile(path.join(rwDir, 'data.txt'), 'writable extra')

    await setupProject('adddir')
    const name = await createSession(
      'adddir', '--add-dir', roDir, '--add-dir-rw', rwDir,
    )

    const { stdout: roOut } = await podmanRetry([
      'exec', name, 'cat', `/add-dir${roDir}/hello.txt`,
    ])
    expect(roOut.trim()).toBe('read-only extra')
    await expect(podmanRetry([
      'exec', name, 'sh', '-c', `echo test > /add-dir${roDir}/fail.txt`,
    ])).rejects.toThrow()

    const { stdout: rwOut } = await podmanRetry([
      'exec', name, 'cat', `/add-dir${rwDir}/data.txt`,
    ])
    expect(rwOut.trim()).toBe('writable extra')
    await podmanRetry([
      'exec', name, 'sh', '-c', `echo new-data > /add-dir${rwDir}/new.txt`,
    ])
    const { stdout: newOut } = await podmanRetry([
      'exec', name, 'cat', `/add-dir${rwDir}/new.txt`,
    ])
    expect(newOut.trim()).toBe('new-data')
  }, 90_000)
})
