import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import { execFileAsync } from '@/lib/container/runtime'
import { JOB_NAME_LABEL, listSessionPods } from '@/lib/k8s/pods'
import { k8sNamespace, kubectlWithRetry } from '@/lib/k8s/kubectl'
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
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@test/helpers/mock-remotes'

/**
 * Reproduces a bug where, after a session pod exits and the remote
 * git HEAD has advanced, `yaac session stream <project>` drives the daemon
 * through `createSession` (via `pickNextStreamSession` at
 * src/daemon/stream-picker.ts) and the resulting session pod was
 * occasionally created without working proxy access — even though the
 * same code path wires up the proxy on first creation. We repeat the
 * create→exit→advance-HEAD→stream cycle because the bug is timing-
 * sensitive; a single pass may miss it.
 */
describe('yaac session stream (session pod exited + remote HEAD changed)', () => {
  // Loop a few times because the bug this test was written to catch is
  // timing-sensitive; a single pass of stop→advance-HEAD→stream often
  // misses the race between session creation and pickup.
  const ITERATIONS = 5

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
  })

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM()
    mockGit = await startMockGit()

    await seedMockGitRepo(mockGit, 'repo-demo', {
      files: { 'README.md': '# demo\n' },
    })
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

  it('new session created after remote HEAD change still routes through proxy', async () => {
    const projectsDir = path.join(testEnv.dataDir, 'projects')
    const projectDir = path.join(projectsDir, 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    const claudeDir = path.join(projectDir, 'claude')
    await fs.mkdir(claudeDir, { recursive: true })

    const localBare = path.join(mockGit!.reposDir, 'repo-demo.git')
    await cloneRepo(localBare, repoDir, null)
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

    const llmTarget = { host: mockLLM!.host, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.host, port: mockGit!.port, tls: false }
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

    // Any failure of the new session to reach the mock — whatever the
    // cause (proxy down, mock dead, namespace broken) — is exactly the
    // real-world failure shape we want to catch: the user's tools can't
    // reach their upstreams. We assert end-to-end reachability + the
    // credential-swap that the proxy would perform against a real API.
    // On proxy-probe failure, capture the pod's view of its proxy wiring
    // (env vars + CA cert) and the proxy/mock pod state. Helps tell "pod
    // created without proxy env" apart from "mock died" apart from
    // "proxy dead" when the flake shows up.
    const dumpDiagnostics = async (jobName: string): Promise<void> => {
      const dumpExec = async (label: string, args: string[]): Promise<void> => {
        try {
          const { stdout, stderr } = await execInJob(jobName, args, { timeout: 5_000 })
          console.error(`--- ${label} ---\n${stdout}${stderr ? '\nSTDERR: ' + stderr : ''}`)
        } catch (err) {
          console.error(`--- ${label} [ERR] ---\n${(err as Error).message}`)
        }
      }
      await dumpExec('session env | proxy', ['sh', '-c', 'env | grep -i -E "proxy|ssl_cert|ca_cert" || echo NONE'])
      await dumpExec('session proxy CA', ['sh', '-c', 'ls -l /etc/yaac/certs 2>&1 | head -3'])
      try {
        const { stdout } = await kubectlWithRetry([
          'get', 'pods', '-n', k8sNamespace(), '-o', 'wide',
        ], { timeout: 5_000 })
        console.error(`--- namespace pods ---\n${stdout}`)
      } catch (err) {
        console.error(`--- namespace pods [ERR] ---\n${(err as Error).message}`)
      }
    }

    const probeProxyAccess = async (jobName: string): Promise<void> => {
      const { stdout, stderr } = await execInJob(jobName, [
        'curl', '-sS', '-k', '-v',
        '--max-time', '10',
        '-X', 'POST',
        '-H', 'x-api-key: yaac-ph-api-key',
        '-H', 'content-type: application/json',
        '-d', '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}',
        'https://api.anthropic.com/v1/messages',
      ], { timeout: 20_000 })
      if (!stdout.includes('Hello from mock')) {
        console.error(`proxy probe on ${jobName} — stdout:\n${stdout}`)
        console.error(`proxy probe on ${jobName} — stderr:\n${stderr}`)
        await dumpDiagnostics(jobName)
      }
      expect(stdout).toContain('Hello from mock')
      const transcript = await mockLLM!.transcript()
      const last = [...transcript].reverse()
        .find((e) => e.method === 'POST' && e.url.startsWith('/v1/messages'))
      expect(last).toBeDefined()
      expect(last!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
    }

    // Find this project's currently-running session Job. Newest-first so
    // repeated iterations pick the latest create.
    const findRunningSessionJob = async (): Promise<string> => {
      const pods = (await listSessionPods('repo-demo')).filter((p) => p.running)
      if (pods.length === 0) throw new Error('no running session pod for repo-demo')
      pods.sort((a, b) => b.createdAtMs - a.createdAtMs)
      return pods[0].jobName
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

    // Bootstrap: `session create` sets up the first session. Sanity-check
    // proxy access before the stale-remote scenario starts.
    const { stdout: createOut, stderr: createErr, exitCode: createExit } = await runYaac(
      daemonEnv, 'session', 'create', 'repo-demo', '--tool', 'claude',
    )
    if (createExit !== 0) {
      console.error('session create stdout:\n' + createOut)
      console.error('session create stderr:\n' + createErr)
    }
    expect(createExit).toBe(0)
    const firstJob = await findRunningSessionJob()
    await probeProxyAccess(firstJob)

    // Simulates the user exiting the tmux session: delete the Job's pod
    // (backoffLimit 0 / restartPolicy Never means kubernetes does not
    // replace it) and wait until the session no longer shows as running.
    const stopSession = async (jobName: string): Promise<void> => {
      try {
        await kubectlWithRetry([
          'delete', 'pod',
          '-n', k8sNamespace(),
          '-l', `${JOB_NAME_LABEL}=${jobName}`,
          '--ignore-not-found', '--grace-period=2',
        ], { timeout: 60_000 })
      } catch { /* tolerated — verify state below */ }
      for (let j = 0; j < 20; j++) {
        const pods = await listSessionPods('repo-demo')
        const stillRunning = pods.some((p) => p.jobName === jobName && p.running)
        if (!stillRunning) return
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error(`session ${jobName} still running after pod delete`)
    }

    for (let i = 1; i <= ITERATIONS; i++) {
      // Stop the current session's pod, simulating the user exiting the
      // tmux session and the pod transitioning to a terminal state.
      const prev = await findRunningSessionJob()
      await stopSession(prev)

      // Remote HEAD moves forward. The daemon's next createSession pass
      // should observe a new fingerprint and provision a session against
      // the fresh origin/main.
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

      const next = await findRunningSessionJob()
      expect(next).not.toBe(prev)
      await probeProxyAccess(next)
    }
    // 5 iterations of stop → advance-HEAD → stream → probe can legitimately
    // take >3 min under the full parallel e2e load, so the budget has
    // headroom over the observed worst-case ~240s.
  }, 360_000)
})
