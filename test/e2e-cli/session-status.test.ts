import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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

const execFileAsync = promisify(execFile)

/**
 * End-to-end coverage for the push-fed session status path: the daemon
 * holds a tmux control-mode watcher per session (status-watcher.ts)
 * subscribed to the agent pane's `#{pane_title}`, and `session list`
 * reads the watcher-fed store — there are no per-list status probes.
 *
 * The test controls the pane title directly (`tmux select-pane -T`)
 * instead of driving a real agent: what's under test is yaac's
 * title→status plumbing, not claude's title behavior (that mapping is
 * pinned by the classifyClaudeTitle unit fixtures). The agent window is
 * first respawned to `sleep infinity` so a crashing fake-cred claude
 * can neither close the window nor fight the test for the title.
 */
describe('session status via the push-fed watcher (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let daemonEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
  })

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
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

  async function setupProject(slug: string): Promise<void> {
    await seedMockGitRepo(mockGit!, slug, { files: { 'README.md': '# demo\n' } })
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
  }

  async function findSessionPod(slug: string): Promise<SessionPod> {
    const pods = await listSessionPods(slug)
    const pod = pods.sort((a, b) => a.createdAtMs - b.createdAtMs)[0]
    if (!pod) throw new Error(`no session pod found for project ${slug}`)
    return pod
  }

  /** Poll `session list` until the project row shows `expected`. */
  async function waitForListStatus(
    slug: string,
    expected: 'running' | 'waiting',
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastOut = ''
    for (;;) {
      const { stdout } = await runYaac(daemonEnv, 'session', 'list', slug)
      lastOut = stdout
      const row = stdout.split('\n').find((l) => l.includes(slug) && !l.startsWith('SESSION'))
      if (row?.includes(expected)) return
      if (Date.now() > deadline) {
        throw new Error(`status never became ${expected} within ${timeoutMs}ms; last list:\n${lastOut}`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  it('pushes pane-title flips into session list, sticky across a watcher stream kill', async () => {
    const slug = 'status-push'
    await setupProject(slug)
    const { exitCode } = await runYaac(daemonEnv, 'session', 'create', slug, '--tool', 'claude')
    expect(exitCode).toBe(0)
    const pod = await findSessionPod(slug)

    // Neutralize the real agent so nothing competes with the test for
    // the pane title: keep the window on process exit, then replace
    // claude with an inert sleep in the same pane (same pane id — the
    // watcher's title subscription survives respawn-window).
    await execInJob(pod.jobName, [
      'tmux', '-S', CONTAINER_TMUX_SOCK, 'set-option', '-t', 'yaac', 'remain-on-exit', 'on',
    ])
    await execInJob(pod.jobName, [
      'tmux', '-S', CONTAINER_TMUX_SOCK, 'respawn-window', '-k', '-t', 'yaac:claude', 'sleep infinity',
    ])

    const setTitle = (title: string): Promise<{ stdout: string }> => execInJob(pod.jobName, [
      'tmux', '-S', CONTAINER_TMUX_SOCK, 'select-pane', '-t', 'yaac:claude.0', '-T', title,
    ])

    // Baseline: an idle-style title classifies as waiting.
    await setTitle('✳ marker-idle')
    await waitForListStatus(slug, 'waiting', 20_000)

    // A Braille-spinner title must flip the list to running with no
    // probe in the path: title → tmux ~1s subscription check → watcher →
    // status store → list read.
    await setTitle('⠋ marker-busy')
    await waitForListStatus(slug, 'running', 20_000)

    // Kill the watcher's kubectl exec child. Status must stay sticky
    // (never blank / never reaped), and the watcher must respawn on its
    // own — proven by the next title flip still landing. execFile (no
    // shell) so no intermediate sh -c carries the pattern in its own
    // cmdline — pkill would match and kill it too.
    await execFileAsync('pkill', ['-f', `job/${pod.jobName}.*attach-session`])
    const { stdout: afterKill } = await runYaac(daemonEnv, 'session', 'list', slug)
    const row = afterKill.split('\n').find((l) => l.includes(slug) && !l.startsWith('SESSION'))
    expect(row).toBeDefined()
    expect(row).toContain('running')

    await setTitle('✳ marker-done')
    await waitForListStatus(slug, 'waiting', 30_000)
  }, 240_000)
})
