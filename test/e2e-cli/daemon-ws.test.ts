import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'
import { requirePodman, requireCluster, cleanupSessionJobs } from '@test/helpers/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@test/helpers/mock-remotes'

/**
 * Wire-level coverage for the daemon's WebSocket surface, per the test
 * strategy in plans/webapp-daemon-follow-up.md:
 *  - /events sends a `snapshot` frame on connect and rejects missing auth.
 *  - /pty/attach reports an error for unknown sessions.
 *  - /pty/attach round-trips bytes against a real session container
 *    (write `echo …`, observe the output) — the webapp's terminal path.
 */

/** Open a WS against the daemon, collecting text + binary frames. */
function openWs(url: string, headers: Record<string, string>): {
  ws: WebSocket
  text: string[]
  binary: () => string
  opened: Promise<void>
  failed: Promise<number>
} {
  const ws = new WebSocket(url, { headers })
  const text: string[] = []
  const chunks: Buffer[] = []
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    if (isBinary) chunks.push(buf)
    else text.push(buf.toString('utf8'))
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  // Tests that expect the upgrade to be refused (e.g. a 401) await
  // `failed`, never `opened` — and their `ws.close()` while still
  // CONNECTING rejects `opened` ("WebSocket was closed before the
  // connection was established"). Attach a no-op handler so that
  // expected rejection doesn't surface as an unhandled rejection;
  // callers that do `await opened` still observe it.
  opened.catch(() => {})
  const failed = new Promise<number>((resolve) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
  })
  return { ws, text, binary: () => Buffer.concat(chunks).toString('utf8'), opened, failed }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('daemon WebSocket surface (real daemon, no containers)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  it('GET /events with a bearer sends a snapshot frame on connect', async () => {
    const { ws, text, opened } = openWs(
      `ws://127.0.0.1:${daemon.lock.port}/events`,
      { authorization: `Bearer ${daemon.lock.secret}` },
    )
    await opened
    // The snapshot is pushed immediately after the upgrade.
    for (let i = 0; i < 50 && text.length === 0; i++) await sleep(100)
    ws.close()
    expect(text.length).toBeGreaterThan(0)
    const frame = JSON.parse(text[0]) as { type: string; data: Record<string, unknown> }
    expect(frame.type).toBe('snapshot')
    expect(frame.data).toMatchObject({ sessions: [], projects: [] })
  })

  it('rejects /events without credentials', async () => {
    const { ws, failed } = openWs(`ws://127.0.0.1:${daemon.lock.port}/events`, {})
    expect(await failed).toBe(401)
    ws.close()
  })

  it('/pty/attach reports an error frame for an unknown session', async () => {
    const { ws, text, opened } = openWs(
      `ws://127.0.0.1:${daemon.lock.port}/pty/attach?id=definitely-bogus`,
      { authorization: `Bearer ${daemon.lock.secret}` },
    )
    await opened
    const closed = new Promise<void>((r) => ws.once('close', () => r()))
    await closed
    expect(text.some((t) => t.includes('"type":"error"'))).toBe(true)
  })
})

describe('PTY WebSocket round-trip (real session pod)', () => {
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
    await seedMockGitRepo(mockGit, 'repo-demo', { files: { 'README.md': '# demo\n' } })
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

  it('writes a command over the WS and reads its output back', async () => {
    // Stage a project the same way session-create-happy does: local bare
    // clone masquerading as a github remote, fake credentials, redirects.
    const projectDir = path.join(testEnv.dataDir, 'projects', 'repo-demo')
    const repoDir = path.join(projectDir, 'repo')
    await fs.mkdir(path.join(projectDir, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, 'repo-demo.git'), repoDir, null)
    const fakeRemote = 'https://github.com/test-org/repo-demo.git'
    await simpleGit(repoDir).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ slug: 'repo-demo', remoteUrl: fakeRemote, addedAt: new Date().toISOString() }) + '\n',
    )
    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(credsDir, 'github.json'),
      JSON.stringify({ tokens: [{ pattern: 'test-org/*', token: 'fake-ghp-token' }] }) + '\n',
    )
    await fs.writeFile(
      path.join(credsDir, 'claude.json'),
      JSON.stringify({ kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-fake-real-key' }) + '\n',
    )
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )

    const llmTarget = { host: mockLLM!.host, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.host, port: mockGit!.port, tls: false }
    const daemonEnv: NodeJS.ProcessEnv = {
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

    const { stdout, stderr, exitCode } = await runYaac(
      daemonEnv, 'session', 'create', 'repo-demo', '--tool', 'claude',
    )
    if (exitCode !== 0) {
      console.error('session create stdout:\n' + stdout)
      console.error('session create stderr:\n' + stderr)
    }
    expect(exitCode).toBe(0)

    // Find the created session over the HTTP API. `session create` returns
    // once the pod is up, but `/session/list` only surfaces a session once
    // its tmux is probe-alive (see classifySessionPods), and a request can
    // briefly share an in-flight list snapshot taken just before that. The
    // real UI polls every ~5s and tolerates the gap, so poll here too
    // rather than asserting on a single immediate fetch.
    const base = `http://127.0.0.1:${daemon.lock.port}`
    const auth = { authorization: `Bearer ${daemon.lock.secret}` }
    const listSession = async (): Promise<{ sessionId: string; status: string }> => {
      const list = await (await fetch(`${base}/session/list?project=repo-demo`, { headers: auth })).json() as
        | { sessions: Array<{ sessionId: string; status: string }> }
        | Array<{ sessionId: string; status: string }>
      const sessions = Array.isArray(list) ? list : list.sessions
      return sessions[0]
    }
    let session = await listSession()
    for (let i = 0; i < 30 && !session; i++) {
      await sleep(500)
      session = await listSession()
    }
    expect(session).toBeDefined()

    // Create a scratch-shell window (the webapp's "+" path), attach it over
    // the WS, and round-trip a command. A shell window needs no agent auth —
    // just the container and tmux.
    const createRes = await fetch(
      `${base}/session/${session.sessionId}/terminals`,
      { method: 'POST', headers: auth },
    )
    expect(createRes.ok).toBe(true)
    const shell = await createRes.json() as { target: string; name: string }
    expect(shell.name).toBe('shell')
    expect(shell.target).toMatch(/^window:@\d+$/)
    const { ws, binary, opened } = openWs(
      `ws://127.0.0.1:${daemon.lock.port}/pty/attach`
        + `?id=${session.sessionId}&target=${encodeURIComponent(shell.target)}&cols=100&rows=30`,
      auth,
    )
    await opened
    await sleep(3000) // let the shell start and paint its prompt
    ws.send(Buffer.from('echo WS_ROUNDTRIP_$((40 + 2))\r'))
    for (let i = 0; i < 30 && !binary().includes('WS_ROUNDTRIP_42'); i++) await sleep(500)
    ws.close()
    expect(binary()).toContain('WS_ROUNDTRIP_42')
  }, 240_000)
})
