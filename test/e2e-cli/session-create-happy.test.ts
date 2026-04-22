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
 * End-to-end infrastructure test: real CLI + real daemon + real podman, with
 * the proxy's `upstreamRedirects` feature rerouting every outbound host the
 * session would normally use (GitHub, Anthropic) to a mock container on the
 * same podman network.
 *
 * We deliberately do NOT try to fully boot `claude-code` inside the session
 * container — its startup hits ~a dozen different endpoints (statsig,
 * bootstrap, policy_limits, mcp-registry, ...) and chasing every response
 * shape couples the test to claude-code's internal flow. Instead we exec
 * `curl` inside the session container and drive a single `POST
 * /v1/messages` through the same proxy + MITM + credential-injection path
 * claude-code would use. That's sufficient to prove the test-mocking
 * infrastructure works; a follow-up test can cover real claude-code once
 * the mock is fleshed out enough to satisfy its bootstrap.
 */
describe('yaac session create (mocked remotes, happy path)', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`

  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    // The proxy creates this network on demand when it spins up. Pre-create
    // so the mock containers can attach before the proxy exists; if it
    // already exists the create is a no-op.
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
    // Remove every container this test created so they don't pile up across
    // runs. Filter by data-dir so we never touch containers owned by a
    // concurrent worker.
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

  it('routes session HTTPS through proxy→redirect→mock with credential injection', async () => {
    // Stage a yaac project on disk as if `yaac project add` had cloned
    // github.com/test-org/repo-demo.git — clone from the local bare repo
    // (fast, no network) and rewrite the remote URL to the pretend github
    // URL so proxy routing + token resolution see it as a github remote.
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

    // Fake credentials. The proxy reads these at MITM time and swaps the
    // container-facing placeholders for the "real" values — the mock
    // ignores them, but the swap is what we assert on.
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

    const { stdout, stderr, exitCode } = await runYaac(
      daemonEnv,
      'session', 'create', 'repo-demo', '--tool', 'claude',
    )

    if (exitCode !== 0) {
      console.error('session create stdout:\n' + stdout)
      console.error('session create stderr:\n' + stderr)
    }
    expect(exitCode).toBe(0)

    // Locate THIS test's session container (scope by data-dir so we don't
    // trip over leaked containers from other workers/runs).
    const { stdout: containerIds } = await podmanRetry([
      'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
      '--filter', 'label=yaac.project=repo-demo',
      '--format', '{{.Names}}|{{.CreatedAt}}',
    ])
    // Oldest-first — the CLI's session is the one session-create returned,
    // which was created before the daemon spun up a background prewarm.
    const containerName = containerIds
      .split('\n').filter(Boolean)
      .sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
      .map((row) => row.split('|')[0])[0]
    expect(containerName).toMatch(/^yaac-repo-demo-/)

    // Drive a single HTTPS request from inside the session container
    // through the proxy: `curl -k` because we don't ship the proxy's CA
    // into the curl invocation (the proxy already installed it into the
    // container's trust store, but `-k` keeps the test deterministic).
    // We send the placeholder x-api-key sentinel that the proxy gates
    // credential injection on — the proxy swaps it for the real value
    // ('sk-ant-fake-real-key') on match.
    const { stdout: curlOut, stderr: curlErr } = await podmanRetry([
      'exec', containerName, 'curl', '-sS', '-k',
      '--max-time', '10',
      '-X', 'POST',
      '-H', 'x-api-key: yaac-ph-api-key',
      '-H', 'content-type: application/json',
      '-d', '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}',
      'https://api.anthropic.com/v1/messages',
    ], { timeout: 20_000 })

    if (!curlOut.includes('Hello from mock')) {
      console.error('curl stdout:\n' + curlOut)
      console.error('curl stderr:\n' + curlErr)
    }
    // The SSE stream carries the mock's text_delta — proves the response
    // reached the container.
    expect(curlOut).toContain('Hello from mock')

    // Mock transcript should show the swapped credential. The container
    // sent the placeholder sentinel; the proxy's dynamic MITM rule
    // (buildDynamicRules, hostname === ANTHROPIC_API_HOST) matches the
    // placeholder and swaps it to the on-disk api-key before forwarding.
    // That's the piece upstream-redirect composes with: MITM + inject +
    // redirect.
    const transcript = await mockLLM!.transcript()
    const messagesCall = transcript.find((e) => e.method === 'POST' && e.url.startsWith('/v1/messages'))
    expect(messagesCall).toBeDefined()
    expect(messagesCall!.headers['x-api-key']).toBe('sk-ant-fake-real-key')
    expect(messagesCall!.body).toContain('claude-sonnet-4-6')
  }, 90_000)
})
