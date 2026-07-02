import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import simpleGit from 'simple-git'
import { cloneRepo } from '@/lib/git'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
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
 * End-to-end coverage for provisioning sessions as first-class snapshot
 * objects, against a REAL daemon (no containers needed — a create against a
 * non-existent project fails fast at project validation, before any cluster or
 * podman interaction). Proves:
 *  - a create registers a provisioning entry surfaced in the `/events` snapshot,
 *  - it carries kind/createdAt and, on failure, an error (kept, not dropped),
 *  - a freshly-opened WS re-hydrates it (the reload-survival mechanism),
 *  - dismiss removes it from the snapshot.
 */

interface ProvisioningEntry {
  sessionId: string
  projectSlug: string
  tool: string
  kind: 'create' | 'restart'
  message: string
  error?: string
  createdAt: string
}
interface Snapshot { sessions: unknown[]; provisioning: ProvisioningEntry[] }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Open a WS and resolve the first `snapshot` frame's data (what a connecting
 *  or reloading browser hydrates from). */
async function firstSnapshot(url: string, secret: string): Promise<Snapshot> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } })
  try {
    const frame = await new Promise<Snapshot>((resolve, reject) => {
      ws.once('error', reject)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        const parsed = JSON.parse(buf.toString('utf8')) as { type: string; data: Snapshot }
        if (parsed.type === 'snapshot') resolve(parsed.data)
      })
    })
    return frame
  } finally {
    ws.close()
  }
}

describe('provisioning sessions in the daemon snapshot (real daemon, no containers)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon
  let base: string
  let auth: Record<string, string>

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
    base = `http://127.0.0.1:${daemon.lock.port}`
    auth = { authorization: `Bearer ${daemon.lock.secret}` }
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  it('surfaces a create as a provisioning entry, survives a reconnect, then dismisses', async () => {
    const sessionId = randomUUID()
    const wsUrl = `ws://127.0.0.1:${daemon.lock.port}/events`

    // A create against a non-existent project: the route registers the
    // provisioning entry up front, then createSession throws NOT_FOUND fast →
    // the entry is marked failed (kept until dismissed).
    const res = await fetch(`${base}/session/create`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'ghost-project', tool: 'claude', sessionId }),
    })
    expect(res.status).toBe(200)
    const ndjson = await res.text()
    // The client-supplied id was accepted (uuid schema) and the create failed.
    expect(ndjson).toContain('"type":"error"')

    // Reconnect (as a reloaded browser would) — the snapshot must still carry
    // the provisioning entry, with its kind, a createdAt, and the error.
    let snap = await firstSnapshot(wsUrl, daemon.lock.secret)
    let entry = snap.provisioning.find((p) => p.sessionId === sessionId)
    // Give the fail-after-reject a beat if the very first reconnect raced it.
    for (let i = 0; i < 20 && !entry?.error; i++) {
      await sleep(100)
      snap = await firstSnapshot(wsUrl, daemon.lock.secret)
      entry = snap.provisioning.find((p) => p.sessionId === sessionId)
    }
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('create')
    expect(entry?.projectSlug).toBe('ghost-project')
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(entry?.error).toBeTruthy()

    // Dismiss drops it from the daemon registry → out of the snapshot.
    const dismiss = await fetch(`${base}/session/provisioning/${sessionId}/dismiss`, {
      method: 'POST',
      headers: auth,
    })
    expect(dismiss.status).toBe(204)

    const after = await firstSnapshot(wsUrl, daemon.lock.secret)
    expect(after.provisioning.some((p) => p.sessionId === sessionId)).toBe(false)
  }, 30_000)
})

/** Collect every `snapshot` frame off a persistent WS, exposing the latest. */
function collectSnapshots(url: string, secret: string): {
  ws: WebSocket
  opened: Promise<void>
  latest: () => Snapshot | null
} {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } })
  let latest: Snapshot | null = null
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    const parsed = JSON.parse(buf.toString('utf8')) as { type: string; data: Snapshot }
    if (parsed.type === 'snapshot') latest = parsed.data
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, opened, latest: () => latest }
}

describe('provisioning hand-off on a real session create (client-supplied id)', () => {
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

  it('a webapp create with a client id yields a real session of that id, and the provisioning row drops on hand-off', async () => {
    // Stage a project exactly like session-create-happy: a local bare clone
    // masquerading as a github remote, fake credentials, redirects.
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
    await fs.writeFile(testEnv.gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n')

    const llmTarget = { host: mockLLM!.host, port: mockLLM!.port, tls: false }
    const gitTarget = { host: mockGit!.host, port: mockGit!.port, tls: false }
    daemon = await spawnYaacDaemon({
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
    })
    const base = `http://127.0.0.1:${daemon.lock.port}`
    const auth = { authorization: `Bearer ${daemon.lock.secret}` }
    const sessionId = randomUUID()

    // Watch the snapshot stream while the create runs.
    const sub = collectSnapshots(`ws://127.0.0.1:${daemon.lock.port}/events`, daemon.lock.secret)
    await sub.opened

    // Fire the webapp create (don't await — we want to observe the in-flight row).
    const createDone = fetch(`${base}/session/create`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'repo-demo', tool: 'claude', sessionId }),
    }).then((r) => r.text())

    // The provisioning row appears in the snapshot during creation.
    let sawProvisioning = false
    for (let i = 0; i < 100; i++) {
      const row = sub.latest()?.provisioning.find((p) => p.sessionId === sessionId)
      if (row) {
        expect(row.kind).toBe('create')
        expect(row.projectSlug).toBe('repo-demo')
        sawProvisioning = true
        break
      }
      await sleep(200)
    }
    expect(sawProvisioning).toBe(true)

    // Creation completes successfully (NDJSON ends with a result, not an error).
    const ndjson = await createDone
    expect(ndjson).toContain('"type":"result"')
    expect(ndjson).not.toContain('"type":"error"')

    // The real session exists under the SAME client-supplied id...
    const list = await (await fetch(`${base}/session/list?project=repo-demo`, { headers: auth })).json() as
      { sessions: Array<{ sessionId: string }> }
    expect(list.sessions.some((s) => s.sessionId === sessionId)).toBe(true)

    // ...and the provisioning row drops on hand-off (the create route removes
    // it when createSession resolves; until then buildSnapshot hides the
    // session so no snapshot ever carries both — no double row, and no
    // terminals mounted against a half-built session).
    let droppedFromProvisioning = false
    for (let i = 0; i < 100; i++) {
      const snap = sub.latest()
      if (snap && snap.sessions.some((s) => (s as { sessionId: string }).sessionId === sessionId)
        && !snap.provisioning.some((p) => p.sessionId === sessionId)) {
        droppedFromProvisioning = true
        break
      }
      await sleep(200)
    }
    expect(droppedFromProvisioning).toBe(true)
    sub.ws.close()
  }, 240_000)
})
