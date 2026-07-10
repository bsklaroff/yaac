import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import simpleGit from 'simple-git'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { addTestProject, createTestRepo, requirePodman, requireCluster } from '@yaac/test-utils/setup'

/**
 * Merged session-CLI suite: one shared `createYaacTestEnv()` + one shared
 * `spawnYaacServer()` for every test in this file, instead of a per-test
 * server. Spawning a server (and waiting on the cross-worker server mutex)
 * dominated the wall-clock of the small per-command files this merges:
 * session-attach, session-delete, session-shell, session-restart,
 * session-list, session-monitor, session-stream, open, the validation-only
 * session-create tests, the no-container server-ws describe, and the
 * no-container session-provisioning describe.
 *
 * Vitest runs tests within a file sequentially in declaration order, which
 * this file exploits: the data dir is SHARED across all tests, so ordering
 * matters —
 *  - the 'empty state' describe runs first, before anything seeds projects
 *    into the shared data dir (its tests assert pristine empty states);
 *  - the validation-error tests run next and create no state;
 *  - the 'with seeded projects' describe runs last and adds projects with
 *    file-unique slugs (no slug is seeded twice — addTestProject can't
 *    re-clone into an existing project dir).
 * NOTHING in this file may seed credentials: the session-create
 * credential-error tests rely on the credentials dir staying empty.
 *
 * Cluster/podman requirements (from the source files): session resolution
 * (attach/shell/delete/restart) lists pods/jobs via kubectl; session list —
 * and each monitor render — queries pods via kubectl even for empty states;
 * pickNextStreamSession always calls listSessionPods; and `createSession`
 * runs `ensureContainerRuntime()` (podman + kubernetes round-trip) before
 * the credential checks the create tests target. So the shared beforeAll
 * requires both podman and a reachable cluster.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  testEnv = await createYaacTestEnv()
  // Global git identity so the CLI's session restart/create don't prompt
  // on stdin. `GIT_CONFIG_GLOBAL` is preset in `testEnv.env`, so seeding
  // this file is the same as populating `~/.gitconfig` without clobbering
  // the real one. The git config file lives outside the server data dir,
  // so writing it here does not violate the empty-state tests below.
  await fs.writeFile(
    testEnv.gitConfigPath,
    '[user]\n\tname = Test User\n\temail = test@example.com\n',
  )
  server = await spawnYaacServer(testEnv.env)
})

afterAll(async () => {
  await server.stop()
  await testEnv.cleanup()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(describeFailure())
}

/** Open a WS against the server, collecting text + binary frames. */
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

/**
 * Spawn `yaac session monitor <args>` as a long-running child (it
 * re-renders forever), mirroring the `server logs -f` e2e pattern:
 * wait for the first render, assert on it, then kill the child.
 */
async function runMonitorUntilFirstRender(...args: string[]): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, [
    path.resolve('node_modules/tsx/dist/cli.mjs'),
    path.resolve('apps/cli/src/cli.ts'),
    'session', 'monitor', ...args,
  ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  try {
    // First render = header line plus the session list body.
    await waitFor(
      () => stdout.includes('yaac session monitor') && stdout.includes('No active sessions'),
      30_000,
      () => `monitor never rendered.\nstdout: ${stdout}\nstderr: ${stderr}`,
    )
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
  return stdout
}

/**
 * These four tests assert PRISTINE empty states (no sessions, no
 * projects) against the shared data dir — they MUST run before any test
 * seeds a project. Nothing in this describe writes server state.
 */
describe('empty state (must run before any state is seeded)', () => {
  it('GET /events with a bearer sends a snapshot frame on connect', async () => {
    const { ws, text, opened } = openWs(
      `ws://127.0.0.1:${server.lock.port}/events`,
      { authorization: `Bearer ${server.lock.secret}` },
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

  it('session list prints the empty-state hint when no sessions exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'session', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No active sessions')
    expect(stdout).toContain('yaac session create')
  })

  it('session stream exits with the empty-state message when no projects exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'session', 'stream')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No projects found')
  })

  it('session monitor renders the header with the default interval and the empty session list', async () => {
    const stdout = await runMonitorUntilFirstRender()
    expect(stdout).toMatch(/yaac session monitor {2}\(every 5s/)
    expect(stdout).toContain('Press Ctrl+C to exit')
    expect(stdout).toContain('No active sessions')
  })
})

/**
 * Wire-level coverage for the server's WebSocket surface, per the test
 * strategy in plans/webapp-server-follow-up.md:
 *  - /events sends a `snapshot` frame on connect (see the empty-state
 *    describe above) and rejects missing auth.
 *  - /pty/attach reports an error for unknown sessions.
 * The /pty/attach byte round-trip against a real session container lives
 * in session-create-suite.test.ts (it needs mock remotes + a session pod).
 */
describe('server WebSocket surface (real server, no containers)', () => {
  it('rejects /events without credentials', async () => {
    const { ws, failed } = openWs(`ws://127.0.0.1:${server.lock.port}/events`, {})
    expect(await failed).toBe(401)
    ws.close()
  })

  it('/pty/attach reports an error frame for an unknown session', async () => {
    const { ws, text, opened } = openWs(
      `ws://127.0.0.1:${server.lock.port}/pty/attach?id=definitely-bogus`,
      { authorization: `Bearer ${server.lock.secret}` },
    )
    await opened
    const closed = new Promise<void>((r) => ws.once('close', () => r()))
    await closed
    expect(text.some((t) => t.includes('"type":"error"'))).toBe(true)
  })
})

/**
 * End-to-end coverage for provisioning sessions as first-class snapshot
 * objects, against a REAL server (no containers needed — a create against a
 * non-existent project fails fast at project validation, before any cluster or
 * podman interaction). Proves:
 *  - a create registers a provisioning entry surfaced in the `/events` snapshot,
 *  - it carries kind/createdAt and, on failure, an error (kept, not dropped),
 *  - a freshly-opened WS re-hydrates it (the reload-survival mechanism),
 *  - dismiss removes it from the snapshot.
 * The provisioning entry lives only in the server's in-memory registry and
 * is dismissed at the end, so no state leaks into later tests.
 */
describe('provisioning sessions in the server snapshot (real server, no containers)', () => {
  it('surfaces a create as a provisioning entry, survives a reconnect, then dismisses', async () => {
    const base = `http://127.0.0.1:${server.lock.port}`
    const auth: Record<string, string> = { authorization: `Bearer ${server.lock.secret}` }
    const sessionId = crypto.randomUUID()
    const wsUrl = `ws://127.0.0.1:${server.lock.port}/events`

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
    let snap = await firstSnapshot(wsUrl, server.lock.secret)
    let entry = snap.provisioning.find((p) => p.sessionId === sessionId)
    // Give the fail-after-reject a beat if the very first reconnect raced it.
    for (let i = 0; i < 20 && !entry?.error; i++) {
      await sleep(100)
      snap = await firstSnapshot(wsUrl, server.lock.secret)
      entry = snap.provisioning.find((p) => p.sessionId === sessionId)
    }
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('create')
    expect(entry?.projectSlug).toBe('ghost-project')
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(entry?.error).toBeTruthy()

    // Dismiss drops it from the server registry → out of the snapshot.
    const dismiss = await fetch(`${base}/session/provisioning/${sessionId}/dismiss`, {
      method: 'POST',
      headers: auth,
    })
    expect(dismiss.status).toBe(204)

    const after = await firstSnapshot(wsUrl, server.lock.secret)
    expect(after.provisioning.some((p) => p.sessionId === sessionId)).toBe(false)
  }, 30_000)
})

/**
 * Fast validation/NOT_FOUND paths. None of these create any server-side
 * state (no projects, no credentials, no sessions).
 */
describe('validation errors (no state created)', () => {
  it('session attach errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'attach', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('session shell errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'shell', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('session delete errors with NOT_FOUND when no session matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'delete', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No session found/i)
  })

  it('session restart errors with NOT_FOUND when no session or worktree matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'restart', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No session found/i)
  })

  it('session restart rejects a relative --add-dir path with an absolute-path error', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'restart', 'sess-x', '--add-dir', 'relative/path',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/absolute/i)
  })

  it('session restart rejects a missing --add-dir-rw path with a not-found error', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'restart', 'sess-x', '--add-dir-rw', '/definitely-missing-dir',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('session list <project> 404s with a helpful message for an unknown slug', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'session', 'list', 'no-such-project')
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/not found|no-such-project/)
  })

  it('session stream errors when the --tool flag is not claude, codex, or opencode', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'session', 'stream', '--tool', 'mystery',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/tool|mystery/)
  })

  it('session create errors out fast when the project slug does not exist', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'session', 'create', 'nope')
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Project "nope" not found/)
  })
})

describe('yaac open (real CLI + real server)', () => {
  it('open --no-browser prints an authenticated webapp URL with a bootstrap code', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'open', '--no-browser')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?bootstrap=[a-f0-9]{64}/)
  })
})

/**
 * From here on, tests seed projects into the SHARED data dir. Every slug
 * is unique across the file (a slug can only be added once), and none of
 * these tests seed credentials — the session-create tests below assert
 * the "No git credential configured" error against the still-empty
 * credentials dir.
 */
describe('with seeded projects', () => {
  describe('yaac session list (real CLI + real server)', () => {
    it('session list <project> filters the empty state by project name', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-empty')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stdout, exitCode } = await runYaac(testEnv.env, 'session', 'list', 'proj-empty')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No active sessions for project "proj-empty"')
    })

    it('session list --deleted shows the empty-deleted message when nothing is recorded', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-nodel')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'session', 'list', 'proj-nodel', '--deleted',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No deleted sessions for project "proj-nodel"')
    })

    it('session list --deleted renders seeded Claude Code JSONL entries with prompts', async () => {
      const slug = 'proj-del'
      const repo = path.join(testEnv.scratchDir, slug)
      await createTestRepo(repo)
      await addTestProject(repo)

      // Seed a Claude Code transcript file so listDeletedSessions() picks it up.
      const sessionsDir = path.join(
        testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
      )
      await fs.mkdir(sessionsDir, { recursive: true })
      const sessionId = crypto.randomUUID()
      const firstMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'port the lexer to rust' },
      })
      await fs.writeFile(
        path.join(sessionsDir, `${sessionId}.jsonl`),
        [
          `{"type":"permission-mode","sessionId":"${sessionId}"}`,
          firstMsg,
          '',
        ].join('\n'),
      )

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'session', 'list', slug, '--deleted',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain(sessionId.slice(0, 8))
      expect(stdout).toContain(slug)
      expect(stdout).toContain('claude')
      expect(stdout).toContain('PROMPT')
      expect(stdout).toContain('port the lexer to rust')
    })

    it('session list --deleted -n caps the rendered rows and hints at the cap', async () => {
      const slug = 'proj-del-many'
      const repo = path.join(testEnv.scratchDir, slug)
      await createTestRepo(repo)
      await addTestProject(repo)

      const sessionsDir = path.join(
        testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
      )
      await fs.mkdir(sessionsDir, { recursive: true })
      const ids = Array.from({ length: 5 }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`)
      for (const id of ids) {
        await fs.writeFile(
          path.join(sessionsDir, `${id}.jsonl`),
          '{"type":"permission-mode"}\n',
        )
      }

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'session', 'list', slug, '--deleted', '-n', '2',
      )
      expect(exitCode).toBe(0)
      const matches = ids.filter((id) => stdout.includes(id.slice(0, 8)))
      expect(matches).toHaveLength(2)
      expect(stdout).toMatch(/showing most recent 2/)
    })

    it('session list --deleted --all omits the cap hint', async () => {
      const slug = 'proj-del-all'
      const repo = path.join(testEnv.scratchDir, slug)
      await createTestRepo(repo)
      await addTestProject(repo)

      const sessionsDir = path.join(
        testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
      )
      await fs.mkdir(sessionsDir, { recursive: true })
      const ids = Array.from({ length: 3 }, () => crypto.randomUUID())
      for (const id of ids) {
        await fs.writeFile(
          path.join(sessionsDir, `${id}.jsonl`),
          '{"type":"permission-mode"}\n',
        )
      }

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'session', 'list', slug, '--deleted', '--all',
      )
      expect(exitCode).toBe(0)
      for (const id of ids) expect(stdout).toContain(id.slice(0, 8))
      expect(stdout).not.toMatch(/showing most recent/)
    })
  })

  describe('yaac session monitor (real CLI + real server)', () => {
    // `-n` and `--interval` are the same commander option; this covers both.
    it('filters by the [project] argument and honors -n <seconds>', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-mon')
      await createTestRepo(repo)
      await addTestProject(repo)

      const stdout = await runMonitorUntilFirstRender('proj-mon', '-n', '1')
      expect(stdout).toMatch(/\(every 1s/)
      expect(stdout).toContain('No active sessions for project "proj-mon"')
    })
  })

  describe('yaac session stream (real CLI + real server)', () => {
    it('exits after the user cancels the project-selection prompt', async () => {
      const repoA = path.join(testEnv.scratchDir, 'proj-a')
      const repoB = path.join(testEnv.scratchDir, 'proj-b')
      await createTestRepo(repoA)
      await createTestRepo(repoB)
      await addTestProject(repoA)
      await addTestProject(repoB)

      // Send a non-numeric answer so the CLI hits the "Invalid selection."
      // branch and returns "No project selected. Exiting session stream."
      // (Other tests' projects also appear in the prompt — the assertions
      // only require proj-a/proj-b to be listed and the cancel to land.)
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'session', 'stream', { stdin: 'x\n' },
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Select a project')
      expect(stdout).toContain('proj-a')
      expect(stdout).toContain('proj-b')
      expect(stdout).toContain('No project selected')
    })
  })

  /**
   * Real CLI + real server + real runtime (podman build engine + cluster).
   *
   * These cover the CLI-initiated session-create VALIDATION paths: the
   * error raised by the server when no GitHub token is configured for the
   * project's remote, and the argument checks in front of it. That flows
   * through the full subprocess→HTTP→Hono→session-create-handler→
   * NDJSON-stream→CLI chain, including `ensureContainerRuntime()` (podman
   * + kubernetes), so it proves the runtime+server plumbing works
   * end-to-end through real processes. The happy-path container-creation
   * coverage lives in session-create-suite.test.ts (mocked remotes).
   *
   * The originals all seeded a project named "repo-demo" into a fresh
   * data dir per test; with the shared data dir each test seeds its own
   * uniquely-slugged project instead.
   */
  describe('yaac session create (real CLI + real server)', () => {
    it('surfaces the server "no git credential" validation error via stderr + nonzero exit', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo')
      await createTestRepo(repo)
      await addTestProject(repo)
      // Override the cloned origin with a URL-shaped value so parseGitRemote
      // succeeds; the credential lookup against an empty store is the real
      // assertion target.
      await simpleGit(path.join(testEnv.dataDir, 'projects', 'repo-demo', 'repo'))
        .remote(['set-url', 'origin', 'https://github.com/test-org/repo-demo.git'])

      const { stderr, exitCode } = await runYaac(
        testEnv.env,
        'session',
        'create',
        'repo-demo',
        '--tool',
        'claude',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/No git credential configured/)
    })

    it('rejects an unknown --tool value via server VALIDATION', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo-tool')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'session', 'create', 'repo-demo-tool', '--tool', 'mystery',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr.toLowerCase()).toContain('tool')
    })

    it('accepts --tool opencode (validation passes through to the git-credential check)', async () => {
      // Mirrors the "no git credential" case above for --tool claude —
      // confirms opencode passes the server's tool-validation gate, then
      // trips the same missing-credential check downstream. Cheap proof
      // that the new tool value is wired through the validator without
      // standing up a real opencode container.
      const repo = path.join(testEnv.scratchDir, 'repo-demo-opencode')
      await createTestRepo(repo)
      await addTestProject(repo)
      await simpleGit(path.join(testEnv.dataDir, 'projects', 'repo-demo-opencode', 'repo'))
        .remote(['set-url', 'origin', 'https://github.com/test-org/repo-demo-opencode.git'])

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'session', 'create', 'repo-demo-opencode', '--tool', 'opencode',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/No git credential configured/)
    })

    it('rejects a relative --add-dir path with an absolute-path error', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo-adddir')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'session', 'create', 'repo-demo-adddir', '--add-dir', 'relative/path',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/absolute/i)
    })
  })
})
