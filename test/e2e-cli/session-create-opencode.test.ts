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
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockGit,
} from '@test/helpers/mock-remotes'

/**
 * Boots a real opencode session container and asserts the in-container
 * HTTP server (`opencode --port 4096 --hostname 127.0.0.1`) actually
 * comes up and answers on `/session` and `/session/status`. The yaac
 * status + first-message helpers in src/lib/session/opencode-status.ts
 * depend on these endpoints being reachable via `podman exec curl`, so
 * without this test the entire opencode status pipeline is unverified
 * by CI.
 *
 * Driving the TUI through a turn (mock LLM, model config, etc.) is out
 * of scope here — the HTTP server runs independently of any configured
 * provider, so reaching `/session/status` is enough to prove the wiring.
 */
describe('yaac session create -t opencode (real CLI + real daemon + real opencode)', () => {
  const networkName = `yaac-test-sessions-${TEST_RUN_ID}`
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon | null = null
  let mockGit: MockGit | null = null

  beforeAll(async () => {
    await requirePodman()
    try { await podmanRetry(['network', 'create', networkName]) } catch { /* exists */ }
  })

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
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
    await cleanupMocks([mockGit])
    mockGit = null
    await testEnv.cleanup()
  })

  it('boots opencode and exposes its HTTP API on 127.0.0.1:4096 inside the container', async () => {
    const projectDir = path.join(testEnv.dataDir, 'projects', 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir, null)
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
    await fs.writeFile(path.join(credsDir, 'opencode.json'), JSON.stringify({
      kind: 'api-key',
      savedAt: new Date().toISOString(),
      apiKey: 'sk-or-v1-fake-test-key',
    }) + '\n')

    await fs.writeFile(testEnv.gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n')

    const daemonEnv: NodeJS.ProcessEnv = {
      ...testEnv.env,
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    }
    daemon = await spawnYaacDaemon(daemonEnv)
    const { exitCode } = await runYaac(daemonEnv, 'session', 'create', 'repo-demo', '--tool', 'opencode')
    expect(exitCode).toBe(0)

    // Find this test's session container. session-create may also kick
    // off a prewarm; the user-facing session is the oldest of the two.
    const { stdout: rows } = await podmanRetry([
      'ps', '--filter', `label=yaac.data-dir=${testEnv.dataDir}`,
      '--filter', 'label=yaac.project=repo-demo',
      '--format', '{{.Names}}|{{.CreatedAt}}',
    ])
    const containerName = rows
      .split('\n').filter(Boolean)
      .sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
      .map((row) => row.split('|')[0])[0]
    expect(containerName).toBeDefined()

    // Poll the in-container HTTP server. opencode bootstraps the worker +
    // SQLite migrations before binding, so allow generous time. -sf
    // suppresses output on connect-refused. This also doubles as a
    // wait-for-container-ready barrier — by the time the probe answers,
    // the tmux session and `opencode` window must be set up.
    let probeOk = false
    let lastStdout = ''
    let lastStderr = ''
    for (let i = 0; i < 60 && !probeOk; i++) {
      try {
        const { stdout } = await podmanRetry([
          'exec', containerName, 'sh', '-c',
          'curl -sf -o /dev/stdout -w "\\n%{http_code}" http://127.0.0.1:4096/session 2>&1',
        ])
        lastStdout = stdout
        // Expect a 200 status code on the trailing line and a JSON-array body
        // (empty array is fine — no user turn has been sent yet).
        const trimmed = stdout.trim()
        const lastNewline = trimmed.lastIndexOf('\n')
        const body = lastNewline >= 0 ? trimmed.slice(0, lastNewline) : ''
        const code = lastNewline >= 0 ? trimmed.slice(lastNewline + 1) : trimmed
        if (code === '200') {
          const parsed: unknown = JSON.parse(body || '[]')
          expect(Array.isArray(parsed)).toBe(true)
          probeOk = true
          break
        }
      } catch (err) {
        lastStderr = err instanceof Error ? err.message : String(err)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    if (!probeOk) {
      // Diagnostic dump before failing — the most common causes are
      // opencode crashing at startup (TUI couldn't init, missing native
      // module, etc.) or the wrong package name in Dockerfile.default.
      try {
        const { stdout: pane } = await podmanRetry([
          'exec', containerName, 'tmux', 'capture-pane', '-p', '-t', 'yaac:opencode',
        ])
        console.error('opencode tmux pane:\n' + pane)
      } catch { /* ignore */ }
      try {
        const { stdout: ps } = await podmanRetry([
          'exec', containerName, 'sh', '-c', 'ps -ef | grep -i opencode | grep -v grep',
        ])
        console.error('opencode processes:\n' + ps)
      } catch { /* ignore */ }
      console.error('last curl stdout: ' + lastStdout)
      console.error('last curl stderr: ' + lastStderr)
    }
    expect(probeOk).toBe(true)

    // Now the status endpoint — must also return JSON (object, not array).
    // A reachable `/session/status` is what `src/lib/session/opencode-status.ts`
    // depends on, so probing it here is the load-bearing assertion of
    // this test. We deliberately don't also check tmux state separately:
    // an `opencode` window is implied by the HTTP server answering on
    // container loopback, and the extra exec is flaky under
    // parallel-test-suite load (race between opencode startup and the
    // tmux window settling).
    const { stdout: statusOut } = await podmanRetry([
      'exec', containerName, 'sh', '-c',
      'curl -sf http://127.0.0.1:4096/session/status',
    ])
    const status: unknown = JSON.parse(statusOut.trim() || '{}')
    expect(typeof status).toBe('object')
    expect(Array.isArray(status)).toBe(false)
  }, 180_000)
})
