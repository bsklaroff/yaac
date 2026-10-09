import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import {
  createYaacTestEnv,
  spawnYaacServer,
  setTestGitIdentity,
  runYaac,
  TEST_CLI_ENTRY,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { addTestProject, createTestRepo, requirePodman, requireCluster } from '@yaac/test-utils/setup'
import {
  recordWorkspaceCreated,
  recordWorkspaceStopped,
} from '@yaac/server/db/workspace-store'
import {
  recordAgentSessions,
  setActiveAgentSessions,
} from '@yaac/server/db/agent-session-store'
import { setDataDir } from '@yaac/shared/paths'
import { closeDb } from '@yaac/server/db/client'
import { firstSnapshot } from '@yaac/test-utils/events-ws'

/**
 * The `yaac workspace` commands that need no running workspace, sharing one
 * test env and server across the file.
 *
 * Tests run in declaration order over one data dir, so order matters:
 *  - the 'empty state' describe runs first, before any project exists;
 *  - the validation-error tests create no state;
 *  - later tests seed projects, each under a unique name, except the
 *    ambiguity case, which gives two projects one name on purpose.
 * Nothing here may seed credentials: the create tests expect the
 * missing-credential error.
 *
 * Listing and resolving workspaces query the cluster even when empty, so
 * this needs podman and a reachable cluster.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer
const TAILNET_HOST = 'srv.tailnet.ts.net'

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  testEnv = await createYaacTestEnv()
  // Admit a tailnet name, so the identity refusal below is reachable past
  // the Host check.
  server = await spawnYaacServer({ ...testEnv.env, YAAC_ALLOWED_HOSTS: TAILNET_HOST })
  await setTestGitIdentity(testEnv.env)
})

afterAll(async () => {
  await server.stop()
  await testEnv.cleanup()
})

/** Open a WS against the server, collecting text + binary frames. */
function openWs(url: string, headers: Record<string, string> = {}): {
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
  // Tests expecting a refused upgrade never await `opened`, which rejects
  // when they close; keep that from becoming an unhandled rejection.
  opened.catch(() => {})
  const failed = new Promise<number>((resolve) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
  })
  return { ws, text, binary: () => Buffer.concat(chunks).toString('utf8'), opened, failed }
}

/**
 * Run `yaac workspace monitor <args>` (which re-renders forever) until its
 * first render, then kill it and return the output.
 */
async function runMonitorUntilFirstRender(...args: string[]): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, [
    TEST_CLI_ENTRY, 'workspace', 'monitor', ...args,
  ], { env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  try {
    await vi.waitFor(() => {
      if (!stdout.includes('yaac workspace monitor') || !stdout.includes('No running workspaces')) {
        throw new Error(`monitor never rendered.\nstdout: ${stdout}\nstderr: ${stderr}`)
      }
    }, { timeout: 30_000, interval: 100 })
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
  return stdout
}

/**
 * Empty-state tests: must run before any project is seeded, and write no
 * server state.
 */
describe('empty state (must run before any state is seeded)', () => {
  it('GET /events sends a snapshot frame on connect', async () => {
    const { ws, text, opened } = openWs(`ws://127.0.0.1:${server.lock.port}/api/events`)
    await opened
    await vi.waitFor(() => expect(text.length).toBeGreaterThan(0), { timeout: 5_000, interval: 100 })
    ws.close()
    const frame = JSON.parse(text[0]) as { type: string; data: Record<string, unknown> }
    expect(frame.type).toBe('snapshot')
    expect(frame.data).toMatchObject({ workspaces: [], projects: [] })
  })

  it('workspace list prints the empty-state hint when no workspaces exist', async () => {
    const { stdout, exitCode } = await runYaac(testEnv.env, 'workspace', 'list')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No running workspaces')
    expect(stdout).toContain('yaac workspace create')
  })

  it('workspace monitor renders the header with the default interval and the empty session list', async () => {
    const stdout = await runMonitorUntilFirstRender()
    expect(stdout).toMatch(/yaac workspace monitor {2}\(every 5s/)
    expect(stdout).toContain('Press Ctrl+C to exit')
    expect(stdout).toContain('No running workspaces')
  })
})

/**
 * The server's WebSocket endpoints without a workspace: /events refuses a
 * caller it cannot identify, and /pty/attach reports an unknown workspace.
 * The /pty/attach round trip is in workspace-create-suite.test.ts.
 */
describe('server WebSocket surface (real server, no containers)', () => {
  it('refuses /events to a caller it cannot identify', async () => {
    // The admitted tailnet name, without tailscale serve in front.
    const { ws, failed } = openWs(`ws://127.0.0.1:${server.lock.port}/api/events`, { host: TAILNET_HOST })
    expect(await failed).toBe(401)
    ws.close()
  })

  it('/api/pty/attach reports an error frame for an unknown session', async () => {
    const { ws, text, opened } = openWs(`ws://127.0.0.1:${server.lock.port}/api/pty/attach?id=definitely-bogus`)
    await opened
    const closed = new Promise<void>((r) => ws.once('close', () => r()))
    await closed
    expect(text.some((t) => t.includes('"type":"error"'))).toBe(true)
  })
})

/**
 * Provisioning entries in the `/api/events` snapshot. A create for a
 * project with no git credential fails fast, with no cluster work. Checks
 * that the entry
 * appears with kind, createdAt and its error, survives a reconnect (as on a
 * page reload), and goes away when dismissed. The entry is in memory only
 * and dismissed at the end, so nothing leaks into later tests.
 */
describe('provisioning sessions in the server snapshot (real server, no containers)', () => {
  it('surfaces a create as a provisioning entry, survives a reconnect, then dismisses', async () => {
    const base = `http://127.0.0.1:${server.lock.port}`
    const workspaceId = crypto.randomUUID()
    const repo = path.join(testEnv.scratchDir, 'proj-provisioning')
    await createTestRepo(repo)
    const projectId = await addTestProject(server, repo)

    // The entry is registered first, then marked failed on the missing
    // credential and kept until dismissed.
    const res = await fetch(`${base}/api/workspace/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'proj-provisioning', tool: 'claude', workspaceId }),
    })
    expect(res.status).toBe(200)
    const ndjson = await res.text()
    expect(ndjson).toContain('"type":"error"')

    // Reconnect, as a reloaded page would.
    // The first reconnect can race the failure being recorded.
    const entry = await vi.waitFor(async () => {
      const snap = await firstSnapshot(server.lock.port)
      const found = snap.provisioning.find((p) => p.workspaceId === workspaceId)
      expect(found?.error).toBeTruthy()
      return found!
    }, { timeout: 10_000, interval: 100 })
    expect(entry.kind).toBe('create')
    expect(entry.projectId).toBe(projectId)
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    const dismiss = await fetch(`${base}/api/workspace/provisioning/${workspaceId}/dismiss`, {
      method: 'POST',
    })
    expect(dismiss.status).toBe(204)

    const after = await firstSnapshot(server.lock.port)
    expect(after.provisioning.some((p) => p.workspaceId === workspaceId)).toBe(false)
  }, 30_000)
})

/** Validation and NOT_FOUND paths. None of these create server state. */
describe('validation errors (no state created)', () => {
  it('workspace attach errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'workspace', 'attach', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('workspace shell errors with NOT_FOUND for a bogus session id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'workspace', 'shell', 'definitely-bogus-id',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/not found/i)
  })

  it('workspace stop errors with NOT_FOUND when no workspace matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'workspace', 'stop', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No workspace found/i)
  })

  it('workspace restart errors with NOT_FOUND when no workspace matches the id', async () => {
    const { stderr, exitCode } = await runYaac(
      testEnv.env, 'workspace', 'restart', 'definitely-no-such-session',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/No workspace found/i)
  })

  it('workspace list <project> 404s with a helpful message for an unknown project', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'workspace', 'list', 'no-such-project')
    expect(exitCode).not.toBe(0)
    expect(stderr.toLowerCase()).toMatch(/not found|no-such-project/)
  })

  it('workspace create errors with NOT_FOUND when the project does not exist', async () => {
    const { stderr, exitCode } = await runYaac(testEnv.env, 'workspace', 'create', 'nope')
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/project nope not found/)
  })
})

/**
 * From here on, tests seed projects, each under a unique name. None seed
 * credentials (see the file header).
 */
describe('with seeded projects', () => {
  describe('yaac workspace list (real CLI + real server)', () => {
    it('workspace list <project> filters the empty state by project name', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-empty')
      await createTestRepo(repo)
      await addTestProject(server, repo)

      const { stdout, exitCode } = await runYaac(testEnv.env, 'workspace', 'list', 'proj-empty')
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No running workspaces for project "proj-empty"')
    })

    it('workspace list --stopped shows the empty-stopped message when nothing is recorded', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-nodel')
      await createTestRepo(repo)
      await addTestProject(server, repo)

      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'list', 'proj-nodel', '--stopped',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No stopped workspaces for project "proj-nodel"')
    })

    /**
     * Stopped-workspace rows, written as a create-then-stop would.
     *
     * proj-del's workspace has no recorded prompt or transcript path, as
     * when a pod dies before the prompt is captured. Its prompt then comes
     * from the transcript at claude's default path (`stoppedPrompt`'s
     * fallback), which is what that test checks.
     *
     * The listings name these projects by id prefix and by full id.
     */
    const DEL_NAME = 'proj-del'
    let delId: string
    let capId: string
    let allId: string
    const promptWorkspaceId = crypto.randomUUID()
    const capIds = Array.from(
      { length: 5 },
      (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
    )
    const allIds = Array.from({ length: 3 }, () => crypto.randomUUID())

    async function seedTranscript(projectId: string, workspaceId: string, body: string): Promise<void> {
      const dir = path.join(
        testEnv.dataDir, 'global', 'projects', projectId, 'claude', 'projects', '-workspace',
      )
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${workspaceId}.jsonl`), body)
    }

    /** One recorded workspace that is stopped, with one claude conversation. */
    async function seedStopped(projectId: string, workspaceId: string): Promise<void> {
      await recordWorkspaceCreated({ projectId: projectId, workspaceId })
      await recordAgentSessions(projectId, workspaceId, [
        { tool: 'claude', agentSessionId: crypto.randomUUID() },
      ])
      await recordWorkspaceStopped(projectId, workspaceId)
    }

    beforeAll(async () => {
      const add = async (name: string): Promise<string> => {
        const repo = path.join(testEnv.scratchDir, name)
        await createTestRepo(repo)
        return await addTestProject(server, repo)
      }
      delId = await add(DEL_NAME)
      capId = await add('proj-del-many')
      allId = await add('proj-del-all')
      const firstMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'port the lexer to rust' },
      })
      // The fallback looks up the transcript by workspace id.
      await seedTranscript(delId, promptWorkspaceId, [
        `{"type":"permission-mode","workspaceId":"${promptWorkspaceId}"}`,
        firstMsg,
        '',
      ].join('\n'))

      // The DB allows one writer, so stop the server to write rows.
      await server.stop()
      setDataDir(testEnv.dataDir)
      await seedStopped(delId, promptWorkspaceId)
      for (const id of capIds) await seedStopped(capId, id)
      for (const id of allIds) await seedStopped(allId, id)
      await closeDb()
      server = await spawnYaacServer(testEnv.env)
    })

    it('workspace list --stopped renders stopped workspaces with their prompts', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'list', delId.slice(0, 8), '--stopped',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain(promptWorkspaceId.slice(0, 8))
      expect(stdout).toContain(DEL_NAME)
      expect(stdout).toContain('claude')
      expect(stdout).toContain('PROMPT')
      expect(stdout).toContain('port the lexer to rust')
    })

    it('workspace list --stopped -n caps the rendered rows and hints at the cap', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'list', capId, '--stopped', '-n', '2',
      )
      expect(exitCode).toBe(0)
      const matches = capIds.filter((id) => stdout.includes(id.slice(0, 8)))
      expect(matches).toHaveLength(2)
      expect(stdout).toMatch(/showing most recent 2 of 5;/)
    })

    it('workspace list --stopped --all omits the cap hint', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'list', allId, '--stopped', '--all',
      )
      expect(exitCode).toBe(0)
      for (const id of allIds) expect(stdout).toContain(id.slice(0, 8))
      expect(stdout).not.toMatch(/showing most recent/)
    })
  })

  /** `yaac workspace rename`: titles are recorded state, so stopped workspaces work. */
  describe('yaac workspace rename (real CLI + real server)', () => {
    const REN_NAME = 'proj-rename'
    const renameId = crypto.randomUUID()
    // Two ids sharing a prefix, for the terminal commands' ambiguity check.
    const twinIds = ['feedface-0000-4000-8000-000000000001', 'feedface-0000-4000-8000-000000000002']

    beforeAll(async () => {
      const repo = path.join(testEnv.scratchDir, REN_NAME)
      await createTestRepo(repo)
      const projectId = await addTestProject(server, repo)
      await server.stop()
      setDataDir(testEnv.dataDir)
      await recordWorkspaceCreated({ projectId, workspaceId: renameId })
      await recordWorkspaceStopped(projectId, renameId)
      for (const id of twinIds) {
        await recordWorkspaceCreated({ projectId, workspaceId: id })
        await recordWorkspaceStopped(projectId, id)
      }
      await closeDb()
      server = await spawnYaacServer(testEnv.env)
    })

    it('sets a stopped workspace\u2019s title, and the listing shows it', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'rename', renameId, 'porting the lexer to rust',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('porting the lexer to rust')

      const listed = await runYaac(testEnv.env, 'workspace', 'list', REN_NAME, '--stopped')
      expect(listed.stdout).toContain('porting the lexer to rust')
    })

    // Refused before any socket opens, not resolved to the first match.
    it('refuses an ambiguous prefix for attach and shell', async () => {
      for (const command of ['attach', 'shell']) {
        const { stderr, exitCode } = await runYaac(testEnv.env, 'workspace', command, 'feedface')
        expect(exitCode, command).not.toBe(0)
        expect(stderr, command).toMatch(/Ambiguous workspace prefix: feedface/)
      }
    })

    it('404s for an id no workspace has', async () => {
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'rename', crypto.randomUUID(), 'nope',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr.toLowerCase()).toContain('not found')
    })
  })

  /**
   * Sidebar groups from the terminal, addressed by name rather than the
   * uuid the webapp uses. Recorded state only, so no cluster is needed.
   * The project is named by name (GRP_NAME), full id or id prefix.
   */
  describe('yaac group (real CLI + real server)', () => {
    const GRP_NAME = 'proj-groups'
    let grpId: string
    const memberId = crypto.randomUUID()
    const otherId = crypto.randomUUID()

    beforeAll(async () => {
      const repo = path.join(testEnv.scratchDir, GRP_NAME)
      await createTestRepo(repo)
      grpId = await addTestProject(server, repo)

      // Write rows with the server stopped (single DB writer). Both are
      // stopped workspaces, which the stopped listing knows by their
      // recorded stop.
      await server.stop()
      setDataDir(testEnv.dataDir)
      for (const workspaceId of [memberId, otherId]) {
        await recordWorkspaceCreated({ projectId: grpId, workspaceId })
        await recordWorkspaceStopped(grpId, workspaceId)
      }
      await closeDb()
      server = await spawnYaacServer(testEnv.env)
    })

    it('group list reports the empty state with the command that fixes it', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'group', 'list', grpId)
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No workspace groups')
      expect(stdout).toContain('yaac group create')
    })

    it('group create is idempotent, so it cannot manufacture an ambiguous name', async () => {
      // Matches `yaac-mama group create`, which reuses a group by name.
      const first = await runYaac(testEnv.env, 'group', 'create', GRP_NAME, 'nightly')
      expect(first.exitCode).toBe(0)
      const again = await runYaac(testEnv.env, 'group', 'create', GRP_NAME, 'nightly')
      expect(again.exitCode).toBe(0)
      expect(again.stdout).toContain('already exists')

      const listed = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(listed.stdout.match(/nightly/g)).toHaveLength(1)

      // Names are compared after the server's whitespace normalization.
      const spaced = await runYaac(testEnv.env, 'group', 'create', GRP_NAME, 'spaced  out')
      expect(spaced.exitCode).toBe(0)
      expect(spaced.stdout).toContain('"spaced out"')
      const retyped = await runYaac(testEnv.env, 'group', 'create', GRP_NAME, 'spaced   out')
      expect(retyped.exitCode).toBe(0)
      expect(retyped.stdout).toContain('already exists')

      const both = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(both.stdout.match(/spaced out/g)).toHaveLength(1)
    })

    it('group move by id reports the group\u2019s name, not the id it was given', async () => {
      const made = await runYaac(testEnv.env, 'group', 'create', GRP_NAME, 'by id')
      const id = /\(([0-9a-f-]{36})\)/.exec(made.stdout)?.[1]
      expect(id).toBeTruthy()

      // The ambiguity error suggests passing an id; the reply still shows
      // the name.
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'group', 'move', memberId, id!, '--project', GRP_NAME,
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('"by id"')
      expect(stdout).not.toContain(id!)
    })

    it('group create makes an empty group, and group list shows it', async () => {
      const created = await runYaac(testEnv.env, 'group', 'create', grpId.slice(0, 8), 'release train')
      expect(created.exitCode).toBe(0)
      expect(created.stdout).toContain('release train')

      const { stdout, exitCode } = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/GROUP\s+PROJECT\s+RUNNING\s+PINNED\s+CREATED/)
      expect(stdout).toContain('release train')
      // An empty group is pinned so it still shows.
      expect(stdout).toMatch(/release train\s+proj-groups\s+0\s+yes/)
    })

    it('group move files a workspace by name, and omitting one ungroups it', async () => {
      const moved = await runYaac(
        testEnv.env, 'group', 'move', memberId, 'release train', '--project', grpId,
      )
      expect(moved.exitCode).toBe(0)
      expect(moved.stdout).toContain('release train')

      // Moving to an unknown name creates the group. The workspace is
      // given by its 8-char prefix, which must be resolved to the full id
      // before the write.
      const fresh = await runYaac(
        testEnv.env, 'group', 'move', otherId.slice(0, 8), 'brand new', '--project', grpId.slice(0, 8),
      )
      expect(fresh.exitCode).toBe(0)
      const grouped = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(grouped.stdout).toMatch(/brand new\s+proj-groups\s+0/)
      const listed = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(listed.stdout).toContain('brand new')

      // No group moves it back to the default list.
      const out = await runYaac(
        testEnv.env, 'group', 'move', memberId, '--project', GRP_NAME,
      )
      expect(out.exitCode).toBe(0)
      expect(out.stdout).toContain('out of its group')
    })

    it('finds a stopped workspace\u2019s project without being told it', async () => {
      // Stopped workspaces are commonly filed, so this needs no --project.
      await runYaac(testEnv.env, 'workspace', 'stop', memberId).catch(() => null)
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'group', 'move', memberId, 'release train',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('release train')
    })

    it('group move reports a workspace it cannot find rather than moving nothing', async () => {
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'group', 'move', crypto.randomUUID(), 'release train',
      )
      expect(exitCode).not.toBe(0)
      // The error points at --project.
      expect(stderr).toContain('--project')
    })

    it('group delete releases its members instead of stopping anything', async () => {
      const { stdout, exitCode } = await runYaac(
        testEnv.env, 'group', 'delete', grpId.slice(0, 8), 'brand new',
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain('default list')

      const listed = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(listed.stdout).not.toContain('brand new')
      const stopped = await runYaac(testEnv.env, 'workspace', 'list', GRP_NAME, '--stopped')
      expect(stopped.stdout).toContain(otherId.slice(0, 8))
    })

    it('group delete refuses an ambiguous name rather than guessing which to destroy', async () => {
      // Duplicate names are made through the API, as the webapp can; the
      // idempotent CLI `group create` cannot make them.
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`http://127.0.0.1:${server.lock.port}/api/workspace/group/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: grpId, name: 'twin' }),
        })
        expect(res.ok).toBe(true)
      }

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'group', 'delete', GRP_NAME, 'twin',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('names 2 groups')

      // Both survive, and the id from the error removes one.
      const listed = await runYaac(testEnv.env, 'group', 'list', GRP_NAME)
      expect(listed.stdout.match(/twin/g)).toHaveLength(2)
      const id = /\(([0-9a-f-]{36})\)/.exec(stderr)?.[1]
        ?? /([0-9a-f-]{36})/.exec(stderr)?.[1]
      expect(id).toBeTruthy()
      const byId = await runYaac(testEnv.env, 'group', 'delete', grpId, id!)
      expect(byId.exitCode).toBe(0)
    })

    it('group delete rejects a name that names nothing', async () => {
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'group', 'delete', GRP_NAME, 'never existed',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('No such group')
    })
  })

  /**
   * `yaac workspace agents`: a workspace's conversations are recorded
   * state that outlives its pod, so no cluster is needed.
   */
  describe('yaac workspace agents (real CLI + real server)', () => {
    const AG_NAME = 'proj-agents'
    const stoppedId = crypto.randomUUID()
    const convA = crypto.randomUUID()
    const convB = crypto.randomUUID()
    const bareId = crypto.randomUUID()

    beforeAll(async () => {
      const repo = path.join(testEnv.scratchDir, AG_NAME)
      await createTestRepo(repo)
      const projectId = await addTestProject(server, repo)

      // The DB allows a single writer (db/client.ts): writes made beside a
      // running server are lost. So stop the server, write the rows, close
      // the handle, then start a new server.
      await server.stop()
      setDataDir(testEnv.dataDir)

      // A stopped workspace with two conversations: one open at stop, one
      // closed by a /clear.
      await recordWorkspaceCreated({ projectId, workspaceId: stoppedId })
      await recordAgentSessions(projectId, stoppedId, [
        { tool: 'claude', agentSessionId: convA, firstPrompt: 'the original ask' },
        { tool: 'claude', agentSessionId: convB, firstPrompt: 'after the clear' },
      ])
      await setActiveAgentSessions(projectId, stoppedId, [
        { tool: 'claude', agentSessionId: convB },
      ])
      await recordWorkspaceStopped(projectId, stoppedId)
      // A workspace with no conversation, for the empty case.
      await recordWorkspaceCreated({ projectId, workspaceId: bareId })

      await closeDb()
      server = await spawnYaacServer(testEnv.env)
    })

    it('workspace agents lists a STOPPED workspace\'s conversations, open first', async () => {
      // Resolved from rows, since a stopped workspace has no pod.
      const { stdout, exitCode } = await runYaac(testEnv.env, 'workspace', 'agents', stoppedId)
      expect(exitCode).toBe(0)
      expect(stdout).toContain(convA)
      expect(stdout).toContain(convB)
      expect(stdout).toContain('the original ask')
      // Open before closed.
      expect(stdout.indexOf(convB)).toBeLessThan(stdout.indexOf(convA))
      expect(stdout).toMatch(/open/)
      expect(stdout).toMatch(/closed/)
    })

    it('workspace agents reports a workspace that has none', async () => {
      const { stdout, exitCode } = await runYaac(testEnv.env, 'workspace', 'agents', bareId)
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No agent sessions recorded')
    })

    it('workspace agents 404s for an id no workspace has', async () => {
      const { stdout, stderr, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'agents', crypto.randomUUID(),
      )
      expect(exitCode).not.toBe(0)
      expect(`${stdout}${stderr}`).toMatch(/not found/i)
    })

  })

  describe('yaac workspace monitor (real CLI + real server)', () => {
    // `-n` is the short form of `--interval`.
    it('filters by the [project] argument and honors -n <seconds>', async () => {
      const repo = path.join(testEnv.scratchDir, 'proj-mon')
      await createTestRepo(repo)
      const prefix = (await addTestProject(server, repo)).slice(0, 8)

      // The project by name, then by id prefix.
      for (const ref of ['proj-mon', prefix]) {
        const stdout = await runMonitorUntilFirstRender(ref, '-n', '1')
        expect(stdout).toMatch(/\(every 1s/)
        expect(stdout).toContain(`No running workspaces for project "${ref}"`)
      }
    })
  })

  /**
   * `yaac workspace create` validation errors: bad arguments, and the
   * server's missing-git-credential error, streamed back to the CLI. The
   * successful path is in workspace-create-suite.test.ts.
   */
  describe('yaac workspace create (real CLI + real server)', () => {
    it('surfaces the server "no git credential" validation error via stderr + nonzero exit', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo')
      await createTestRepo(repo)
      // A parseable remote, so the create reaches the credential lookup.
      await addTestProject(server, repo, { remoteUrl: 'https://github.com/test-org/repo-demo.git' })

      const { stderr, exitCode } = await runYaac(
        testEnv.env,
        'workspace',
        'create',
        'repo-demo',
        '--tool',
        'claude',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/has no git credential/)
    })

    it('rejects an unknown --tool value via server VALIDATION', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo-tool')
      await createTestRepo(repo)
      await addTestProject(server, repo)

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'create', 'repo-demo-tool', '--tool', 'mystery',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr.toLowerCase()).toContain('tool')
    })

    it('accepts --tool opencode (validation passes through to the git-credential check)', async () => {
      // Reaching the credential error shows opencode passed tool validation.
      const repo = path.join(testEnv.scratchDir, 'repo-demo-opencode')
      await createTestRepo(repo)
      const id = await addTestProject(server, repo, { remoteUrl: 'https://github.com/test-org/repo-demo-opencode.git' })

      // Named by full id.
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'create', id, '--tool', 'opencode',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/has no git credential/)
    })

    it('accepts --model for a non-claude tool (passes through to the git-credential check)', async () => {
      // Reaching the credential error shows --model passed validation.
      const repo = path.join(testEnv.scratchDir, 'repo-demo-model-tool')
      await createTestRepo(repo)
      const id = await addTestProject(server, repo, { remoteUrl: 'https://github.com/test-org/repo-demo-model-tool.git' })

      // Named by id prefix.
      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'create', id.slice(0, 8),
        '--tool', 'codex', '--model', 'gpt-5.2-codex',
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/has no git credential/)
    })

    it('rejects a --model value with shell-unsafe characters via schema validation', async () => {
      const repo = path.join(testEnv.scratchDir, 'repo-demo-model-bad')
      await createTestRepo(repo)
      await addTestProject(server, repo)

      const { stderr, exitCode } = await runYaac(
        testEnv.env, 'workspace', 'create', 'repo-demo-model-bad',
        '--tool', 'claude', '--model', "opus'; rm -rf /",
      )
      expect(exitCode).not.toBe(0)
      expect(stderr.toLowerCase()).toContain('model')
    })
  })

  /**
   * Adding the same remote twice gives two projects with one name, which
   * every `<project>` argument then refuses, listing both ids.
   */
  describe('a project name two projects share', () => {
    it('is refused by every command that takes a project, naming both candidates', async () => {
      const ids: string[] = []
      for (const dir of ['twin-a', 'twin-b']) {
        const repo = path.join(testEnv.scratchDir, dir, 'proj-twin')
        await createTestRepo(repo)
        ids.push(await addTestProject(server, repo))
      }
      for (const args of [
        ['workspace', 'create', 'proj-twin', '--tool', 'claude'],
        ['workspace', 'list', 'proj-twin'],
        ['workspace', 'list', 'proj-twin', '--stopped'],
        ['group', 'create', 'proj-twin', 'g'],
        ['group', 'list', 'proj-twin'],
        ['group', 'delete', 'proj-twin', 'g'],
        ['group', 'move', crypto.randomUUID(), 'g', '--project', 'proj-twin'],
      ]) {
        const { stderr, exitCode } = await runYaac(testEnv.env, ...args)
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stderr, args.join(' ')).toContain('matches more than one project')
        for (const id of ids) expect(stderr, args.join(' ')).toContain(id)
      }
    })
  })
})
