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
 * Boots real codex-cli inside a mocked session, types a single prompt, and
 * asserts the mock LLM saw the ChatGPT-backend responses call with the
 * proxy's real Bearer token swapped in and that codex rendered the mock's
 * reply text in its pane. Counterpart to session-create-claude.test.ts,
 * exercising the codex-specific paths: the ChatGPT-shaped `auth.json`
 * placeholder, the `Authorization: Bearer` swap on `chatgpt.com`, and the
 * Responses-API SSE shape.
 *
 * `/repo` (not `/workspace`) is the key codex sees because the session
 * worktree's .git file points at /repo/.git.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-placeholder`
}

describe('yaac session create drives real codex-cli through mocked remotes', () => {
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

  it('boots codex-cli and round-trips a prompt through the mock LLM', async () => {
    const projectDir = path.join(testEnv.dataDir, 'projects', 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    const codexHostDir = path.join(projectDir, 'codex')
    await fs.mkdir(codexHostDir, { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir)
    await simpleGit(repoDir).remote(['set-url', 'origin', 'https://github.com/test-org/repo-demo.git'])
    await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
      slug: 'repo-demo',
      remoteUrl: 'https://github.com/test-org/repo-demo.git',
      addedAt: new Date().toISOString(),
    }) + '\n')

    // Codex OAuth bundle on the host — driving session-create down the
    // writeProjectCodexPlaceholder path, which seeds a ChatGPT-mode
    // auth.json that codex can load without running its native login flow.
    const futureExpSeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    const idJwt = makeJwt({
      sub: 'user-mock',
      email: 'test@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-mock',
        chatgpt_user_id: 'user-mock',
      },
    })
    const realAccessToken = 'codex-real-access-token'

    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }],
    }) + '\n')
    await fs.writeFile(path.join(credsDir, 'codex.json'), JSON.stringify({
      kind: 'oauth',
      savedAt: new Date().toISOString(),
      codexOauth: {
        accessToken: realAccessToken,
        refreshToken: 'codex-real-refresh-token',
        idTokenRawJwt: idJwt,
        expiresAt: futureExpSeconds * 1000,
        lastRefresh: new Date().toISOString(),
        accountId: 'acct-mock',
      },
    }) + '\n')

    await fs.writeFile(testEnv.gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n')

    // Redirect every OpenAI / ChatGPT / GitHub host codex's startup touches
    // through the mock. `auth.openai.com` covers background refresh attempts.
    const llmTarget = { host: mockLLM!.networkIp, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.networkIp, port: mockGit!.port, tls: false }
    const redirects = {
      'github.com': gitTarget,
      'api.github.com': gitTarget,
      'api.openai.com': llmTarget,
      'auth.openai.com': llmTarget,
      'chatgpt.com': llmTarget,
      'ab.chatgpt.com': llmTarget,
      'openai.com': llmTarget,
      'cdn.openai.com': llmTarget,
    }
    const daemonEnv: NodeJS.ProcessEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify(redirects),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    daemon = await spawnYaacDaemon(daemonEnv)
    const { exitCode } = await runYaac(daemonEnv, 'session', 'create', 'repo-demo', '--tool', 'codex')
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

    // Wait for codex-cli to render its main prompt.
    await new Promise((r) => setTimeout(r, 5000))

    const send = async (...keys: string[]): Promise<void> => {
      for (const k of keys) {
        await podmanRetry([
          'exec', '-w', '/', containerName, 'tmux', 'send-keys',
          '-t', 'yaac:codex', k,
        ])
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    // Capture only the visible window, not scrollback history. Dismissed
    // dialogs stay visible in scrollback and would otherwise cause the
    // dispatch loop to keep matching them.
    const capturePane = async (): Promise<string> => {
      try {
        const { stdout } = await podmanRetry([
          'exec', '-w', '/', containerName, 'sh', '-c',
          'tmux capture-pane -t yaac:codex -p 2>&1',
        ])
        return stdout
      } catch (err) {
        return '[capture failed: ' + (err instanceof Error ? err.message : String(err)) + ']'
      }
    }
    // Codex greets new sessions with two modal prompts we need to dismiss
    // before the chat composer is reachable:
    //   1. "Do you trust the contents of this directory?" — accept default
    //      (Yes, continue) with Enter.
    //   2. "Introducing GPT-5.4 … 1. Try new model, 2. Use existing model"
    //      — Down + Enter ("Use existing model") so the test isn't coupled
    //      to a specific default model name in the mock.
    // Dialogs render synchronously after codex's startup HTTP probes, but
    // we don't know which is on screen at a given moment, so watch the
    // pane and dispatch until the chat-composer prompt appears.
    let sawTrust = false
    let sawUpgrade = false
    let inChat = false
    let lastPane = ''
    for (let i = 0; i < 60 && !inChat; i++) {
      lastPane = await capturePane()
      if (/Do you trust the contents of this directory/i.test(lastPane)) {
        if (!sawTrust) {
          await send('Enter')
          sawTrust = true
        }
      } else if (/Introducing GPT|Try new model|Use existing model/i.test(lastPane)) {
        if (!sawUpgrade) {
          await send('Down', 'Enter')
          sawUpgrade = true
        }
      } else if (/OpenAI Codex|gpt-5|YOLO mode/i.test(lastPane)) {
        inChat = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!inChat) {
      console.error('chat composer never appeared (trust=' + sawTrust + ', upgrade=' + sawUpgrade + ')')
      console.error('final pane:\n' + lastPane)
    }
    expect(inChat).toBe(true)
    // Let the chat UI fully render.
    await new Promise((r) => setTimeout(r, 1000))

    await send('hello mock')
    await new Promise((r) => setTimeout(r, 500))
    await send('Enter')

    // Poll for codex rendering the mock's response text in its pane.
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

    // The mock must have received the Responses-API call and the proxy
    // must have swapped the placeholder Bearer for the real on-disk token.
    const transcript = await mockLLM!.transcript()
    const responsesCalls = transcript.filter((e) =>
      e.method === 'POST' && e.url.startsWith('/backend-api/codex/responses'),
    )
    expect(responsesCalls.length).toBeGreaterThan(0)
    const auth = responsesCalls[0].headers['authorization']
    const authStr = Array.isArray(auth) ? auth[0] : auth
    expect(authStr).toBe('Bearer ' + realAccessToken)
    expect(responsesCalls[0].body).toContain('hello mock')
  }, 180_000)
})
