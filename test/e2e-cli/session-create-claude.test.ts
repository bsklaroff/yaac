import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
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
 * Boots real claude-code inside a mocked session, types a single prompt,
 * and asserts the mock LLM saw the `/v1/messages` call and claude rendered
 * the mock's response text in its pane. This is the strongest test of the
 * mocking infrastructure: it exercises the real tool, not a curl stand-in.
 *
 * First-run wizard is skipped by pre-seeding the two files claude-code
 * writes when onboarding completes: `~/.claude.json` (onboarding flags,
 * approved api-key list, per-project trust) and `~/.claude/settings.json`
 * (bypass-permissions auto-accept). Keys used:
 *   - hasCompletedOnboarding = true           — skips theme + security
 *   - customApiKeyResponses.approved          — skips "detected api key"
 *   - projects["/repo"].hasTrustDialogAccepted — skips trust-folder
 *   - settings.json.skipDangerousModePermissionPrompt — skips bypass-perms
 * `/repo` (not `/workspace`) is the key claude uses because the session
 * worktree's .git file points at /repo/.git and git resolves the repo
 * root to /repo.
 */
describe('yaac session create drives real claude-code through mocked remotes', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    try { await podmanRetry(['network', 'create', networkName]) } catch { /* exists */ }
  })

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    mockLLM = await startMockLLM(networkName)
    mockGit = await startMockGit(networkName)
    await seedMockGitRepo(mockGit, 'repo-demo', { files: { 'README.md': '# demo\n' } })
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
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('boots claude-code and round-trips a prompt through the mock LLM', async () => {
    const projectDir = path.join(testEnv.dataDir, 'projects', 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    const claudeHostDir = path.join(projectDir, 'claude')
    await fs.mkdir(claudeHostDir, { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir)
    await simpleGit(repoDir).remote(['set-url', 'origin', 'https://github.com/test-org/repo-demo.git'])
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: 'repo-demo',
      remoteUrl: 'https://github.com/test-org/repo-demo.git',
      addedAt: new Date().toISOString(),
    }) + '\n')

    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
    }) + '\n')
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-fake-real-key',
    }) + '\n')
    await fs.writeFile(testEnv.gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n')

    // Pre-seed claude-code's onboarding state so the first-run wizard is
    // skipped. These mount as /home/yaac/.claude.json and
    // /home/yaac/.claude/settings.json in the session container.
    await fs.writeFile(path.join(projectDir, 'claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.116',
      customApiKeyResponses: { approved: ['placeholder'], rejected: [] },
      projects: {
        '/repo': { hasTrustDialogAccepted: true },
        '/workspace': { hasTrustDialogAccepted: true },
      },
    }) + '\n')
    await fs.writeFile(path.join(claudeHostDir, 'settings.json'), JSON.stringify({
      skipDangerousModePermissionPrompt: true,
    }) + '\n')

    // Redirect every Anthropic / Claude / statsig host claude-code's
    // startup touches. Missing any of these causes claude's background
    // task to 502 and the whole process to unwind.
    const llmTarget = { host: mockLLM!.networkIp, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.networkIp, port: mockGit!.port, tls: false }
    const redirects = {
      'github.com': gitTarget, 'api.github.com': gitTarget,
      'api.anthropic.com': llmTarget,
      'statsig.anthropic.com': llmTarget,
      'api.statsig.com': llmTarget,
      'platform.claude.com': llmTarget,
      'docs.claude.com': llmTarget,
      'code.claude.com': llmTarget,
      'claude.com': llmTarget,
      'claude.ai': llmTarget,
      'mcp-proxy.anthropic.com': llmTarget,
    }
    const daemonEnv: NodeJS.ProcessEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify(redirects),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    daemon = await spawnYaacDaemon(daemonEnv)
    const { exitCode } = await runYaac(daemonEnv, 'session', 'create', 'repo-demo', '--tool', 'claude')
    expect(exitCode).toBe(0)

    // Find this test's session container (oldest of the project's
    // containers — the daemon spins up a prewarm after session-create
    // completes, which is newer).
    const { stdout: containerIds } = await podmanRetry([
      'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
      '--filter', 'label=yaac.project=repo-demo',
      '--format', '{{.Names}}|{{.CreatedAt}}',
    ])
    const containerName = containerIds
      .split('\n').filter(Boolean)
      .sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
      .map((row) => row.split('|')[0])[0]
    expect(containerName).toBeDefined()

    // Wait for claude-code to show its main chat prompt. With the
    // pre-seeded onboarding state this happens directly on startup, no
    // wizard navigation needed.
    await new Promise((r) => setTimeout(r, 4000))

    const send = async (...keys: string[]): Promise<void> => {
      for (const k of keys) {
        await podmanRetry([
          'exec', '-w', '/', containerName, 'tmux', 'send-keys',
          '-t', 'yaac:claude', k,
        ])
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    const capturePane = async (): Promise<string> => {
      const { stdout } = await podmanRetry([
        'exec', '-w', '/', containerName, 'sh', '-c',
        'tmux capture-pane -t yaac:claude -p -S - -E - 2>&1',
      ])
      return stdout
    }

    await send('hello mock')
    await new Promise((r) => setTimeout(r, 500))
    await send('Enter')

    // Poll for claude rendering the mock's response text in its pane.
    // The mock always replies with "Hello from mock!" text_delta.
    let pane = ''
    let hitMockText = false
    for (let i = 0; i < 30; i++) {
      pane = await capturePane()
      if (pane.includes('Hello from mock')) { hitMockText = true; break }
      await new Promise((r) => setTimeout(r, 500))
    }

    if (!hitMockText) {
      console.error('final pane:\n' + pane)
      const tx = await mockLLM!.transcript()
      console.error('mock transcript (' + tx.length + ' entries):')
      for (const e of tx) {
        const host = typeof e.headers.host === 'string' ? e.headers.host : '?'
        console.error('  ' + e.method + ' ' + host + e.url)
      }
    }
    expect(hitMockText).toBe(true)

    // The mock LLM must have received exactly the /v1/messages call that
    // produced the rendered response, and the proxy must have swapped the
    // placeholder x-api-key for the on-disk credential.
    const transcript = await mockLLM!.transcript()
    const messagesCalls = transcript.filter((e) =>
      e.method === 'POST' && e.url.startsWith('/v1/messages'),
    )
    expect(messagesCalls.length).toBeGreaterThan(0)
    expect(messagesCalls[0].headers['x-api-key']).toBe('sk-ant-fake-real-key')
    expect(messagesCalls[0].body).toContain('hello mock')
  }, 120_000)
})
