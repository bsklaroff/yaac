import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import { execFileAsync } from '@/lib/container/runtime'
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
 * Reproduces a bug where, after a session container exits and the remote
 * git HEAD has advanced, `yaac session stream <project>` drives the daemon
 * through `createSession` (via `pickNextStreamSession` at
 * src/daemon/stream-picker.ts:113) and the resulting container is
 * occasionally created without working proxy access — even though the
 * same code path wires up the proxy on first creation. We repeat the
 * create→exit→advance-HEAD→stream cycle because the bug is timing-
 * sensitive; a single pass may miss it.
 */
describe('yaac session stream (container exited + remote HEAD changed)', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`
  // Loop a few times because the bug this test was written to catch is
  // timing-sensitive; a single pass of stop→advance-HEAD→stream often
  // misses the race between prewarm creation and claim.
  const ITERATIONS = 5

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    try {
      await podmanRetry(['network', 'create', networkName])
    } catch { /* already exists */ }
  })

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM(networkName)
    mockGit = await startMockGit(networkName)

    await seedMockGitRepo(mockGit, 'repo-demo', {
      files: { 'README.md': '# demo\n' },
    })
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
      if (names.length > 0) {
        await podmanRetry(['rm', '-f', ...names])
      }
    } catch { /* best effort */ }
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('new container created after remote HEAD change still routes through proxy', async () => {
    const projectsDir = path.join(testEnv.dataDir, 'projects')
    const projectDir = path.join(projectsDir, 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    const claudeDir = path.join(projectDir, 'claude')
    await fs.mkdir(claudeDir, { recursive: true })

    const localBare = path.join(mockGit!.reposDir, 'repo-demo.git')
    await cloneRepo(localBare, repoDir)
    const fakeRemote = 'https://github.com/test-org/repo-demo.git'
    await simpleGit(repoDir).remote(['set-url', 'origin', fakeRemote])

    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        slug: 'repo-demo',
        remoteUrl: fakeRemote,
        addedAt: new Date().toISOString(),
      }) + '\n',
    )

    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({
        tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
      }) + '\n',
    )
    await fs.writeFile(
      path.join(credsDir, 'claude.json'),
      JSON.stringify({
        kind: 'api-key',
        savedAt: new Date().toISOString(),
        apiKey: 'sk-ant-fake-real-key',
      }) + '\n',
    )

    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )

    const llmTarget = { host: mockLLM!.networkIp, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.networkIp, port: mockGit!.port, tls: false }
    const redirects = {
      'github.com': gitTarget,
      'api.github.com': gitTarget,
      'api.anthropic.com': llmTarget,
    }
    const daemonEnv: NodeJS.ProcessEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify(redirects),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    daemon = await spawnYaacDaemon(daemonEnv)

    // Any failure of the new container to reach the mock — whatever the
    // cause (proxy down, mock dead, network broken) — is exactly the
    // real-world failure shape we want to catch: the user's tools can't
    // reach their upstreams. We assert end-to-end reachability + the
    // credential-swap that the proxy would perform against a real API.
    // On proxy-probe failure, capture the container's view of its
    // proxy wiring (env vars + CA cert) and the proxy/mock container
    // state. Helps tell "container created without proxy env" apart
    // from "mock died" apart from "proxy dead" when the flake shows up.
    const dumpDiagnostics = async (containerName: string): Promise<void> => {
      const dump = async (label: string, args: string[]): Promise<void> => {
        try {
          const { stdout, stderr } = await podmanRetry(args, { timeout: 5_000 })
          console.error(`--- ${label} ---\n${stdout}${stderr ? '\nSTDERR: ' + stderr : ''}`)
        } catch (err) {
          console.error(`--- ${label} [ERR] ---\n${(err as Error).message}`)
        }
      }
      await dump('session env | proxy', ['exec', containerName, 'sh', '-c', 'env | grep -i -E "proxy|ssl_cert|ca_cert" || echo NONE'])
      await dump('session /tmp/proxy-ca.pem', ['exec', containerName, 'sh', '-c', 'ls -l /tmp/proxy-ca.pem 2>&1 | head -2; head -1 /tmp/proxy-ca.pem 2>&1'])
      await dump('session networks', ['inspect', containerName, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'])
      await dump('proxy ps', ['ps', '-a', '--filter', 'label=yaac.proxy=true', '--format', '{{.Names}} {{.Status}} {{.Networks}}'])
      await dump('mock ps', ['ps', '-a', '--filter', 'label=yaac.test=true', '--format', '{{.Names}} {{.Status}} {{.Networks}}'])
    }

    const probeProxyAccess = async (containerName: string): Promise<void> => {
      const { stdout, stderr } = await podmanRetry([
        'exec', containerName, 'curl', '-sS', '-k', '-v',
        '--max-time', '10',
        '-X', 'POST',
        '-H', 'x-api-key: yaac-ph-api-key',
        '-H', 'content-type: application/json',
        '-d', '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}',
        'https://api.anthropic.com/v1/messages',
      ], { timeout: 20_000 })
      if (!stdout.includes('Hello from mock')) {
        console.error(`proxy probe on ${containerName} — stdout:\n${stdout}`)
        console.error(`proxy probe on ${containerName} — stderr:\n${stderr}`)
        await dumpDiagnostics(containerName)
      }
      expect(stdout).toContain('Hello from mock')
      const transcript = await mockLLM!.transcript()
      const last = [...transcript].reverse()
        .find((e) => e.method === 'POST' && e.url.startsWith('/v1/messages'))
      expect(last).toBeDefined()
      expect(last!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
    }

    // Find this project's currently-running session container (excluding
    // prewarm containers — they carry no sessionId of interest for the
    // user-facing stream flow).
    const findRunningSessionContainer = async (): Promise<string> => {
      const { stdout } = await podmanRetry([
        'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
        '--filter', 'label=yaac.project=repo-demo',
        '--filter', 'status=running',
        '--format', '{{.Names}}|{{.CreatedAt}}',
      ])
      const rows = stdout.split('\n').filter(Boolean)
      if (rows.length === 0) throw new Error('no running container for repo-demo')
      // Newest-first so repeated iterations pick the latest create.
      rows.sort((a, b) => b.split('|')[1].localeCompare(a.split('|')[1]))
      return rows[0].split('|')[0]
    }

    // Advance origin/main in the bare repo AND in the daemon's local
    // tracking ref, since YAAC_E2E_SKIP_FETCH disables the daemon-side
    // `fetchOrigin` that would normally do this.
    let commitCounter = 0
    const advanceRemoteHead = async (): Promise<void> => {
      commitCounter += 1
      const marker = `bump-${commitCounter}-${Date.now()}`
      await execFileAsync('git', ['-C', localBare, 'commit-tree',
        '-m', marker,
        '-p', 'HEAD',
        'HEAD^{tree}',
      ]).then(async ({ stdout }) => {
        const newSha = stdout.trim()
        await execFileAsync('git', ['-C', localBare, 'update-ref', 'refs/heads/main', newSha])
        await execFileAsync('git', ['-C', localBare, 'update-server-info'])
        // Mirror the change into the daemon-visible tracking ref.
        await execFileAsync('git', ['-C', repoDir, 'fetch', localBare,
          '+refs/heads/main:refs/remotes/origin/main',
        ])
      })
    }

    // Bootstrap: `session create` sets up the first container (and kicks
    // the background-loop into prewarming on the next tick). Sanity-check
    // proxy access before the stale-remote scenario starts.
    const { stdout: createOut, stderr: createErr, exitCode: createExit } = await runYaac(
      daemonEnv, 'session', 'create', 'repo-demo', '--tool', 'claude',
    )
    if (createExit !== 0) {
      console.error('session create stdout:\n' + createOut)
      console.error('session create stderr:\n' + createErr)
    }
    expect(createExit).toBe(0)
    const firstContainer = await findRunningSessionContainer()
    await probeProxyAccess(firstContainer)

    // Stops the container without asserting success — rootless netavark
    // occasionally errors during network teardown (e.g. "remove aardvark
    // entries: IO error") after the container process has already been
    // SIGKILL'd, which is fine for our purposes.
    const stopContainer = async (name: string): Promise<void> => {
      try {
        await podmanRetry(['stop', '-t', '2', name])
      } catch { /* tolerated — verify state below */ }
      for (let j = 0; j < 20; j++) {
        const { stdout } = await podmanRetry([
          'inspect', '--format', '{{.State.Running}}', name,
        ]).catch(() => ({ stdout: 'false' }))
        if (stdout.trim() !== 'true') return
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error(`container ${name} still running after stop`)
    }

    for (let i = 1; i <= ITERATIONS; i++) {
      // Stop the current session's container, simulating the user exiting
      // the tmux session and the container transitioning to exited state.
      const prev = await findRunningSessionContainer()
      await stopContainer(prev)

      // Remote HEAD moves forward. The daemon's next createSession pass
      // (or its prewarm upkeep) should observe a new fingerprint and
      // provision a container against the fresh origin/main.
      await advanceRemoteHead()

      const { stdout, stderr, exitCode } = await runYaac(
        daemonEnv, 'session', 'stream', 'repo-demo',
      )
      if (exitCode !== 0) {
        console.error(`[iter ${i}] session stream stdout:\n${stdout}`)
        console.error(`[iter ${i}] session stream stderr:\n${stderr}`)
      }
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/Attaching to session/)

      const next = await findRunningSessionContainer()
      expect(next).not.toBe(prev)
      await probeProxyAccess(next)
    }
    // 5 iterations of stop → advance-HEAD → stream → probe can legitimately
    // take >3 min under the full parallel e2e load, so the budget has
    // headroom over the observed worst-case ~240s.
  }, 360_000)
})
