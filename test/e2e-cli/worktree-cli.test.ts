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
import {
  recordWorktreeCreated,
  recordWorktreeStopped,
} from '@yaac/server/features/sessions/worktree-store'
import {
  recordAgentSessions,
  setActiveAgentSessions,
} from '@yaac/server/features/sessions/agent-session-store'
import { setDataDir } from '@yaac/shared/paths'
import { closeDb } from '@yaac/server/platform/db'
import { SESSIONS_BACKFILLED_KEY, clearFlag } from '@yaac/server/features/projects'
import { firstSnapshot } from '@yaac/test-utils/events-ws'

/**
 * Merged session-CLI suite: one shared `createYaacTestEnv()` + one shared
 * `spawnYaacServer()` for every test in this file, instead of a per-test
 * server. Spawning a server (and waiting on the cross-worker server mutex)
 * dominated the wall-clock of the small per-command files this merges:
 * session-attach, session-delete, session-shell, session-restart,
 * session-list, session-monitor, open, the validation-only
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
 * and `createSession` runs `ensureContainerRuntime()` (podman + kubernetes
 * round-trip) before
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

/**
 * Spawn `yaac worktree monitor <args>` as a long-running child (it
 * re-renders forever), mirroring the `server logs -f` e2e pattern:
 * wait for the first render, assert on it, then kill the child.
 */
async function runMonitorUntilFirstRender(...args: string[]): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, [
    path.resolve('node_modules/tsx/dist/cli.mjs'),
    path.resolve('packages/cli/src/cli.ts'),
    'worktree', 'monitor', ...args,
  ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  try {
    // First render = header line plus the session list body.
    await waitFor(
      () => stdout.includes('yaac worktree monitor') && stdout.includes('No running worktrees'),
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
    expect(frame.data).toMatchObject({ worktrees: [], projects: [] })
  })

  it('worktree list prints the empty-state hint when no worktrees exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'worktree', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No running worktrees')
    expect(stdout).toContain('yaac worktree create')
  })

  it('worktree monitor renders the header with the default interval and the empty session list', async () => {
    const stdout = await runMonitorUntilFirstRender()
    expect(stdout).toMatch(/yaac worktree monitor {2}\(every 5s/)
    expect(stdout).toContain('Press Ctrl+C to exit')
    expect(stdout).toContain('No running worktrees')
  })
})

/**
 * Wire-level coverage for the server's WebSocket surface:
 *  - /events sends a `snapshot` frame on connect (see the empty-state
 *    describe above) and rejects missing auth.
 *  - /pty/attach reports an error for unknown sessions.
 * The /pty/attach byte round-trip against a real session container lives
 * in worktree-create-suite.test.ts (it needs mock remotes + a session pod).
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

    // A create against a non-existent project: the route registers the
    // provisioning entry up front, then createSession throws NOT_FOUND fast →
    // the entry is marked failed (kept until dismissed).
    const res = await fetch(`${base}/worktree/create`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'ghost-project', tool: 'claude', worktreeId: sessionId }),
    })
    expect(res.status).toBe(200)
    const ndjson = await res.text()
    // The client-supplied id was accepted (uuid schema) and the create failed.
    expect(ndjson).toContain('"type":"error"')

    // Reconnect (as a reloaded browser would) — the snapshot must still carry
    // the provisioning entry, with its kind, a createdAt, and the error.
    let snap = await firstSnapshot(server.lock.port, server.lock.secret)
    let entry = snap.provisioning.find((p) => p.worktreeId === sessionId)
    // Give the fail-after-reject a beat if the very first reconnect raced it.
    for (let i = 0; i < 20 && !entry?.error; i++) {
      await sleep(100)
      snap = await firstSnapshot(server.lock.port, server.lock.secret)
      entry = snap.provisioning.find((p) => p.worktreeId === sessionId)
    }
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe('create')
    expect(entry?.projectSlug).toBe('ghost-project')
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(entry?.error).toBeTruthy()

    // Dismiss drops it from the server registry → out of the snapshot.
    const dismiss = await fetch(`${base}/worktree/provisioning/${sessionId}/dismiss`, {
      method: 'POST',
      headers: auth,
    })
    expect(dismiss.status).toBe(204)

    const after = await firstSnapshot(server.lock.port, server.lock.secret)
    expect(after.provisioning.some((p) => p.worktreeId === sessionId)).toBe(false)
  }, 30_000)
})

/**
 * Fast validation/NOT_FOUND paths. None of these create any server-side
 * state (no projects, no credentials, no sessions).
 */
describe('validation errors (no state created)', () => {
  it('worktree attach errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'worktree', 'attach', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('worktree shell errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'worktree', 'shell', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('worktree stop errors with NOT_FOUND when no worktree matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'worktree', 'stop', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No worktree found/i)
  })

  it('worktree restart errors with NOT_FOUND when no worktree matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'worktree', 'restart', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No worktree found/i)
  })

  it('worktree list <project> 404s with a helpful message for an unknown slug', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'worktree', 'list', 'no-such-project')
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/not found|no-such-project/)
  })

  it('worktree create errors out fast when the project slug does not exist', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'worktree', 'create', 'nope')
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Project "nope" not found/)
  })
})

describe('yaac open (real CLI + real server)', () => {
  it('open --no-browser prints an authenticated webapp URL with a one-time token', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'open', '--no-browser')
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{64}/)
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
  describe('yaac worktree list (real CLI + real server)', () => {
    it('worktree list <project> filters the empty state by project name', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-empty')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stdout, exitCode } = await runYaac(testEnv.env, 'worktree', 'list', 'proj-empty')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No running worktrees for project "proj-empty"')
    })

    it('worktree list --stopped shows the empty-stopped message when nothing is recorded', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-nodel')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'list', 'proj-nodel', '--stopped',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No stopped worktrees for project "proj-nodel"')
    })

    /**
     * Stopped-worktree fixtures. The listing reads recorded rows, so these are
     * adopted the way any worktree predating the tables is: the server's
     * startup sweep takes the transcripts they left behind.
     *
     * That sweep is one-shot, gated on the durable `SESSIONS_BACKFILLED_KEY`
     * preference — NOT on the tables being empty — and the flag is set at the
     * first boot against a data dir. So the transcripts must be on disk
     * before *that* boot, not merely before the restart below; the flag is
     * cleared here to re-arm the sweep for fixtures seeded afterwards.
     */
    const DEL_SLUG = 'proj-del'
    const CAP_SLUG = 'proj-del-many'
    const ALL_SLUG = 'proj-del-all'
    const promptSessionId = crypto.randomUUID()
    const capIds = Array.from(
      { length: 5 },
      (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
    )
    const allIds = Array.from({ length: 3 }, () => crypto.randomUUID())

    async function seedTranscript(slug: string, sessionId: string, body: string): Promise<void> {
      const dir = path.join(
        testEnv.dataDir, 'projects', slug, 'claude', 'projects', '-workspace',
      )
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), body)
    }

    beforeAll(async () => {
      for (const slug of [DEL_SLUG, CAP_SLUG, ALL_SLUG]) {
        const repo = path.join(testEnv.scratchDir, slug)
        await createTestRepo(repo)
        await addTestProject(repo)
      }
      const firstMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'port the lexer to rust' },
      })
      await seedTranscript(DEL_SLUG, promptSessionId, [
        `{"type":"permission-mode","sessionId":"${promptSessionId}"}`,
        firstMsg,
        '',
      ].join('\n'))
      for (const id of capIds) await seedTranscript(CAP_SLUG, id, '{"type":"permission-mode"}\n')
      for (const id of allIds) await seedTranscript(ALL_SLUG, id, '{"type":"permission-mode"}\n')

      // Re-arm the one-shot sweep: the first boot of this data dir already
      // set the flag, long before these transcripts existed. Written with the
      // server stopped — the DB has a single writer (see the agents describe).
      await server.stop()
      setDataDir(testEnv.dataDir)
      await clearFlag(SESSIONS_BACKFILLED_KEY)
      await closeDb()
      // Restart so the sweep runs against the seeded data dir. The CLI finds
      // the new server through the lock file, like any other client.
      server = await spawnYaacServer(testEnv.env)
    })

    it('worktree list --stopped renders adopted worktrees with their prompts', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'list', DEL_SLUG, '--stopped',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain(promptSessionId.slice(0, 8))
      expect(stdout).toContain(DEL_SLUG)
      expect(stdout).toContain('claude')
      expect(stdout).toContain('PROMPT')
      expect(stdout).toContain('port the lexer to rust')
    })

    it('worktree list --stopped -n caps the rendered rows and hints at the cap', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'list', CAP_SLUG, '--stopped', '-n', '2',
      )
      expect(exitCode).toBe(0)
      const matches = capIds.filter((id) => stdout.includes(id.slice(0, 8)))
      expect(matches).toHaveLength(2)
      expect(stdout).toMatch(/showing most recent 2/)
    })

    it('worktree list --stopped --all omits the cap hint', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'list', ALL_SLUG, '--stopped', '--all',
      )
      expect(exitCode).toBe(0)
      for (const id of allIds) expect(stdout).toContain(id.slice(0, 8))
      expect(stdout).not.toMatch(/showing most recent/)
    })
  })

  /**
   * The agent-session listing, against a real server and a real DB. It is
   * about *recorded* state — a worktree's conversations outlive its pod — so
   * it needs no cluster, and the stopped case is the one that shipped broken
   * because nothing drove it end to end.
   */
  describe('yaac worktree agents (real CLI + real server)', () => {
    const AG_SLUG = 'proj-agents'
    const stoppedId = crypto.randomUUID()
    const convA = crypto.randomUUID()
    const convB = crypto.randomUUID()
    const bareId = crypto.randomUUID()

    beforeAll(async () => {
      const repo = path.join(testEnv.scratchDir, AG_SLUG)
      await createTestRepo(repo)
      await addTestProject(repo)

      // The DB has exactly one writer — the running server holds it, and
      // `.server.lock` is the guard (platform/db/client.ts). Opening it from
      // this process alongside the server loses every write to the server's
      // own checkpoint, so the server is stopped FIRST, the rows written
      // while nothing else holds the file, our handle closed, and only then
      // is a fresh server spawned to read them.
      await server.stop()
      setDataDir(testEnv.dataDir)

      // A stopped worktree holding two conversations: one still open at stop,
      // one closed by a /clear — written the way the registry would have.
      await recordWorktreeCreated({ projectSlug: AG_SLUG, worktreeId: stoppedId })
      await recordAgentSessions(AG_SLUG, stoppedId, [
        { tool: 'claude', agentSessionId: convA, firstPrompt: 'the original ask' },
        { tool: 'claude', agentSessionId: convB, firstPrompt: 'after the clear' },
      ])
      // Only convB was live when it stopped; convA is history.
      await setActiveAgentSessions(AG_SLUG, stoppedId, [
        { tool: 'claude', agentSessionId: convB },
      ])
      await recordWorktreeStopped(AG_SLUG, stoppedId)
      // A worktree with a row but no conversation, for the empty case.
      await recordWorktreeCreated({ projectSlug: AG_SLUG, worktreeId: bareId })

      await closeDb()
      server = await spawnYaacServer(testEnv.env)
    })

    it('worktree agents lists a STOPPED worktree\'s conversations, open first', async () => {
      // The command's whole purpose: pick a conversation to restart. A
      // stopped worktree has no pod, so resolving through one 404s.
      const { stdout, exitCode } = await runYaac(testEnv.env, 'worktree', 'agents', stoppedId)
      expect(exitCode).toBe(0)
      expect(stdout).toContain(convA)
      expect(stdout).toContain(convB)
      expect(stdout).toContain('the original ask')
      // Open before closed, whatever their ordinal.
      expect(stdout.indexOf(convB)).toBeLessThan(stdout.indexOf(convA))
      expect(stdout).toMatch(/open/)
      expect(stdout).toMatch(/closed/)
    })

    it('worktree agents reports a worktree that has none', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'worktree', 'agents', bareId)
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No agent sessions recorded')
    })

    it('worktree agents 404s for an id no worktree has', async () => {
      // The negative case, asserted positively: a test that only checked for
      // the *absence* of some message would pass on this output too.
      const { stdout, stderr, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'agents', crypto.randomUUID(),
      )
      expect(exitCode).not.toBe(0)
      expect(`${stdout}${stderr}`).toMatch(/not found/i)
    })

  })

  describe('yaac worktree monitor (real CLI + real server)', () => {
    // `-n` and `--interval` are the same commander option; this covers both.
    it('filters by the [project] argument and honors -n <seconds>', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-mon')
      await createTestRepo(repo)
      await addTestProject(repo)

      const stdout = await runMonitorUntilFirstRender('proj-mon', '-n', '1')
      expect(stdout).toMatch(/\(every 1s/)
      expect(stdout).toContain('No running worktrees for project "proj-mon"')
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
   * coverage lives in worktree-create-suite.test.ts (mocked remotes).
   *
   * The originals all seeded a project named "repo-demo" into a fresh
   * data dir per test; with the shared data dir each test seeds its own
   * uniquely-slugged project instead.
   */
  describe('yaac worktree create (real CLI + real server)', () => {
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
        'worktree',
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
        testEnv.env, 'worktree', 'create', 'repo-demo-tool', '--tool', 'mystery',
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
        testEnv.env, 'worktree', 'create', 'repo-demo-opencode', '--tool', 'opencode',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/No git credential configured/)
    })

    it('accepts --model for a non-claude tool (passes through to the git-credential check)', async () => {
      // Mirrors the --tool opencode case above: a codex create with a
      // provider/model override clears validation (any tool takes --model
      // now) and trips the missing-credential check downstream — cheap
      // proof the flag is wired through without standing up a container.
      const repo = path.join(testEnv.scratchDir, 'repo-demo-model-tool')
      await createTestRepo(repo)
      await addTestProject(repo)
      await simpleGit(path.join(testEnv.dataDir, 'projects', 'repo-demo-model-tool', 'repo'))
        .remote(['set-url', 'origin', 'https://github.com/test-org/repo-demo-model-tool.git'])

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'create', 'repo-demo-model-tool',
        '--tool', 'codex', '--model', 'gpt-5.2-codex',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/No git credential configured/)
    })

    it('rejects a --model value with shell-unsafe characters via schema validation', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo-model-bad')
      await createTestRepo(repo)
      await addTestProject(repo)

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'worktree', 'create', 'repo-demo-model-bad',
        '--tool', 'claude', '--model', "opus'; rm -rf /",
      )
      expect(exitCode).not.toBe(0)
      expect(stderr.toLowerCase()).toContain('model')
    })
  })
})
