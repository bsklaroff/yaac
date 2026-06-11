import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import { listSessionPods, type SessionPod } from '@/lib/k8s/pods'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import {
  requirePodman,
  requireCluster,
  execInJob,
  cleanupSessionJobs,
} from '@test/helpers/setup'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
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
 * the real CLI + real daemon + real cluster. Uses the same mock-remote
 * harness as `session-create-happy.test.ts`: the proxy rewrites GitHub /
 * Anthropic hostnames to mock pods in the test namespace so
 * session-create's GitHub-token + credential-injection paths are
 * satisfied without touching the real internet.
 *
 * Deliberately deferred:
 *   - pnpm cache reuse — exercises pnpm store behavior, not CLI surface.
 * Removed with the kubernetes migration (yaac-config.json now rejects the
 * keys outright — see config.test.ts):
 *   - pgRelay
 *   - nestedContainers
 */
describe('yaac session create features (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let daemonEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
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
    await seedMockGitRepo(mockGit!, slug, { files })

    const projectPath = path.join(testEnv.dataDir, 'projects', slug)
    const repoPath = path.join(projectPath, 'repo')
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), repoPath, null)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await simpleGit(repoPath).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
      slug,
      remoteUrl: fakeRemote,
      addedAt: new Date().toISOString(),
    }) + '\n')

    if (opts.yaacConfig) {
      const configDir = path.join(projectPath, 'config')
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(
        path.join(configDir, 'yaac-config.json'),
        JSON.stringify(opts.yaacConfig, null, 2) + '\n',
      )
    }
  }

  async function findSessionPod(slug: string): Promise<SessionPod> {
    // listSessionPods scopes by the data-dir-hash label, so we never trip
    // over pods owned by a concurrent worker. Oldest-first so we always
    // grab the CLI's session.
    const pods = await listSessionPods(slug)
    const pod = pods.sort((a, b) => a.createdAtMs - b.createdAtMs)[0]
    if (!pod) throw new Error(`no session pod found for project ${slug}`)
    return pod
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
    return (await findSessionPod(slug)).jobName
  }

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    await seedCredentials()
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )
    mockLLM = await startMockLLM()
    mockGit = await startMockGit()

    const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
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
    await cleanupSessionJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('provisions pod, worktree, mounts, git, and tmux', async () => {
    await setupProject('basics')
    const name = await createSession('basics')

    const pod = await findSessionPod('basics')
    expect(pod.running).toBe(true)
    expect(pod.labels['yaac.project']).toBe('basics')
    expect(pod.labels['yaac.tool']).toBe('claude')
    const sessionId = pod.sessionId
    expect(sessionId).toBeTruthy()

    await execInJob(name, ['test', '-d', '/home/yaac/.claude'])
    await execInJob(name, ['test', '-f', '/home/yaac/.claude.json'])
    await execInJob(name, ['test', '-d', '/home/yaac/.codex'])

    const { stdout: lsOut } = await execInJob(name, ['ls', '/workspace'])
    expect(lsOut).toContain('README.md')

    // kubectl exec has no workdir flag — cd inside the shell instead.
    const { stdout: gitStatus } = await execInJob(name, [
      'sh', '-c', 'cd /workspace && git status --porcelain',
    ])
    expect(gitStatus.trim()).toBe('')
    const { stdout: branch } = await execInJob(name, [
      'sh', '-c', 'cd /workspace && git rev-parse --abbrev-ref HEAD',
    ])
    expect(branch.trim()).toBe(`agent/${sessionId}`)

    const { stdout: tmuxList } = await execInJob(name, [
      'tmux', '-S', CONTAINER_TMUX_SOCK, 'list-sessions',
    ])
    expect(tmuxList).toContain('yaac')
    const { stdout: statusRight } = await execInJob(name, [
      'tmux', '-S', CONTAINER_TMUX_SOCK,
      'show-option', '-t', 'yaac', 'status-right',
    ])
    expect(statusRight).toContain(sessionId.slice(0, 8))

    await expect(execInJob(name, [
      'test', '-f', '/tmp/yaac-prompt',
    ])).rejects.toThrow()
  }, 180_000)

  it('passes envPassthrough vars to the container', async () => {
    await setupProject('passthrough', {
      yaacConfig: { envPassthrough: ['YAAC_TEST_VAR'] },
    })
    const name = await createSession('passthrough')

    const { stdout } = await execInJob(name, ['env'])
    expect(stdout).toContain('YAAC_TEST_VAR=hello-from-host')
  }, 180_000)

  it('mounts shared Claude and Codex state in Codex sessions', async () => {
    await setupProject('shared-codex')
    const { stdout, stderr, exitCode } = await runYaac(
      daemonEnv, 'session', 'create', 'shared-codex', '--tool', 'codex',
    )
    if (exitCode !== 0) {
      throw new Error(`exit ${exitCode}\nstdout:${stdout}\nstderr:${stderr}`)
    }
    const pod = await findSessionPod('shared-codex')
    expect(pod.labels['yaac.tool']).toBe('codex')
    const name = pod.jobName

    await execInJob(name, ['test', '-d', '/home/yaac/.claude'])
    await execInJob(name, ['test', '-f', '/home/yaac/.claude.json'])
    await execInJob(name, ['test', '-d', '/home/yaac/.codex'])
  }, 180_000)

  it('mounts named cacheVolumes from config', async () => {
    // cacheVolumes are hostPath dirs under the project dir on the k8s
    // backend, so they vanish with the temp data dir — no host-side
    // volume cleanup needed.
    await setupProject('cache-vol', {
      yaacConfig: { cacheVolumes: { 'test-cache': '/tmp/test-cache' } },
    })
    const name = await createSession('cache-vol')

    await execInJob(name, [
      'sh', '-c', 'echo hello > /tmp/test-cache/marker',
    ])
    const { stdout } = await execInJob(name, [
      'cat', '/tmp/test-cache/marker',
    ])
    expect(stdout.trim()).toBe('hello')
  }, 180_000)

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
        await execInJob(name, ['test', '-f', '/tmp/init-ran'])
        ran = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    expect(ran).toBe(true)
  }, 180_000)

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

    // Port forwarding runs through the daemon's per-connection
    // `kubectl exec nc` relay, not any kubernetes port mapping, so the
    // pod spec has no port map — status-right is the user-facing surface
    // for the chosen host ports.
    const { stdout: statusRight } = await execInJob(name, [
      'tmux', '-S', CONTAINER_TMUX_SOCK,
      'show-option', '-t', 'yaac', 'status-right',
    ])
    const match8080 = statusRight.match(/:(\d+)->8080/)
    const match3000 = statusRight.match(/:(\d+)->3000/)
    expect(match8080).not.toBeNull()
    expect(match3000).not.toBeNull()
    expect(Number(match8080![1])).toBeGreaterThanOrEqual(29080)
    expect(Number(match3000![1])).toBeGreaterThanOrEqual(24000)
  }, 180_000)

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

    const { stdout: roContent } = await execInJob(name, [
      'cat', '/mnt/ro-data/readme.txt',
    ])
    expect(roContent.trim()).toBe('read-only content')
    await expect(execInJob(name, [
      'sh', '-c', 'echo test > /mnt/ro-data/fail.txt',
    ])).rejects.toThrow()

    const { stdout: rwContent } = await execInJob(name, [
      'cat', '/mnt/rw-data/data.txt',
    ])
    expect(rwContent.trim()).toBe('writable content')
    await execInJob(name, [
      'sh', '-c', 'echo new-data > /mnt/rw-data/new.txt',
    ])
    const { stdout: newContent } = await execInJob(name, [
      'cat', '/mnt/rw-data/new.txt',
    ])
    expect(newContent.trim()).toBe('new-data')
  }, 180_000)

  it('redirects /workspace/node_modules through .cached-packages and cleans up on delete', async () => {
    // Real Node projects gitignore node_modules; seed the same so
    // `git status` stays clean once the bind mount is populated.
    await setupProject('ephemeral-modules', {
      files: { '.gitignore': 'node_modules\n' },
    })
    const name = await createSession('ephemeral-modules')

    const pod = await findSessionPod('ephemeral-modules')
    const sessionId = pod.sessionId
    expect(sessionId).toBeTruthy()

    // Inside the container: /workspace/node_modules is a real directory
    // backed by a bind mount — not a symlink (Node's fs.mkdir would
    // reject a symlink-to-dir with ENOTDIR, breaking pnpm).
    await expect(execInJob(name, [
      'readlink', '/workspace/node_modules',
    ])).rejects.toThrow()
    const { stdout: ftype } = await execInJob(name, [
      'stat', '-c', '%F', '/workspace/node_modules',
    ])
    expect(ftype.trim()).toBe('directory')

    // Write to the bind mount and confirm the bytes land in the
    // host-side .cached-packages tree, NOT in the worktree.
    await execInJob(name, [
      'sh', '-c',
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
    const { stdout: gitStatus } = await execInJob(name, [
      'sh', '-c', 'cd /workspace && git status --porcelain',
    ])
    expect(gitStatus.trim()).toBe('')

    // Seed the pnpm-store so the post-delete assertion below can verify
    // that modules/<sid> is reaped while the shared store survives.
    await execInJob(name, [
      'sh', '-c',
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
    await expect(execInJob(name, [
      'test', '-e', '/workspace/node_modules',
    ])).rejects.toThrow()
  }, 180_000)

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

    const { stdout: roOut } = await execInJob(name, [
      'cat', `/add-dir${roDir}/hello.txt`,
    ])
    expect(roOut.trim()).toBe('read-only extra')
    await expect(execInJob(name, [
      'sh', '-c', `echo test > /add-dir${roDir}/fail.txt`,
    ])).rejects.toThrow()

    const { stdout: rwOut } = await execInJob(name, [
      'cat', `/add-dir${rwDir}/data.txt`,
    ])
    expect(rwOut.trim()).toBe('writable extra')
    await execInJob(name, [
      'sh', '-c', `echo new-data > /add-dir${rwDir}/new.txt`,
    ])
    const { stdout: newOut } = await execInJob(name, [
      'cat', `/add-dir${rwDir}/new.txt`,
    ])
    expect(newOut.trim()).toBe('new-data')
  }, 180_000)
})
