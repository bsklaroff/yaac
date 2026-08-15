import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { createTestRepo, addTestProject } from '@yaac/test-utils/setup'
import { collectSnapshots } from '@yaac/test-utils/events-ws'
import {
  containerlessJobName,
  containerlessWorkspacePaths,
  workspaceHome,
} from '@yaac/server/drivers/containerless/paths'
import { builtinSkillsDir, sharedSkillRoots } from '@yaac/server/domain/skills'

const execFileAsync = promisify(execFile)

/**
 * End-to-end coverage for the containerless driver: the real CLI against a
 * real server that runs worktrees as tmux sessions on this host.
 *
 * No cluster, no images, no proxy — which is the point. Everything the
 * cluster tier needs a namespace, a registry and a pod for, this one gets
 * from tmux and a checkout, so the whole file costs a few seconds and can
 * run beside other workers.
 *
 * One test env, one server, and one worktree carry the file: creating a
 * worktree is still the slowest thing here, and every read-only case can
 * share the same one. The tests that destroy their subject run LAST.
 *
 * The host needs `tmux` and `git`; agent CLIs it does not, because the suite
 * puts a fake one on PATH. That is deliberate rather than a shortcut: what
 * is under test is the launch, the exec transport, the port scan and the
 * recovery, none of which care what the agent process is — and a real agent
 * would need credentials and a network.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer
let serverEnv: NodeJS.ProcessEnv
let repoPath: string
let worktreeId: string

const SLUG = 'cl-demo'

/** Whether this host can run the suite at all — the same two binaries
 *  `yaac host check` calls required. */
async function hostReady(): Promise<boolean> {
  for (const bin of ['tmux', 'git']) {
    try {
      await execFileAsync('sh', ['-c', `command -v ${bin}`])
    } catch {
      return false
    }
  }
  return true
}

const CAN_RUN = await hostReady()

/** Whether this host can run an ACP agent — see the skipped case below. */
const ACP_ADAPTER_ON_PATH = await execFileAsync('sh', ['-c', 'command -v claude-agent-acp'])
  .then(() => true, () => false)

/**
 * A stand-in agent on PATH: it holds its tmux window open the way a real
 * TUI does. Without one the respawned window would exit instantly, tmux
 * would close it, and with no windows left the session — and the worktree —
 * would end before any assertion ran.
 *
 * `codex` is the deliberate exception: it stands in for an agent that is
 * installed but cannot run (a broken or half-installed binary), which is
 * exactly the launch failure a PATH check cannot predict. Nothing else in
 * this file creates a codex worktree, so one tool can be the sick one.
 */
async function installFakeAgents(binDir: string): Promise<void> {
  await fs.mkdir(binDir, { recursive: true })
  for (const tool of ['claude', 'opencode', 'pi']) {
    const file = path.join(binDir, tool)
    await fs.writeFile(file, '#!/bin/sh\nexec sleep infinity\n')
    await fs.chmod(file, 0o755)
  }
  const broken = path.join(binDir, 'codex')
  await fs.writeFile(broken, '#!/bin/sh\necho "codex: cannot execute" >&2\nexit 127\n')
  await fs.chmod(broken, 0o755)
}

/** The spawned server's own origin and credential — it binds a per-worker
 *  port and authenticates with its lock secret. */
const origin = (): string => `http://127.0.0.1:${String(server.lock.port)}`
const authHeader = (): Record<string, string> =>
  ({ Authorization: `Bearer ${server.lock.secret}` })

/** The tmux socket the driver derives for a worktree — the same derivation
 *  the server used, so this is an independent check that it landed there. */
function sockFor(id: string): string {
  return containerlessWorkspacePaths(containerlessJobName(SLUG, id)).tmuxSock
}

/** The worktrees the server currently reports, newest first. */
async function listWorktrees(): Promise<Array<{ worktreeId: string; status: string }>> {
  const res = await fetch(`${origin()}/worktree/list`, { headers: authHeader() })
  const body = await res.json() as { worktrees: Array<{ worktreeId: string; status: string }> }
  return body.worktrees
}

/** Create a worktree and answer with its id. The CLI prints none for a tui
 *  worktree (it would have attached to it), so it is read back from the
 *  server's own listing. */
async function createWorktree(): Promise<string> {
  const before = new Set((await listWorktrees()).map((w) => w.worktreeId))
  const { stdout, stderr, exitCode } = await runYaac(
    serverEnv, 'worktree', 'create', SLUG, '--tool', 'claude',
  )
  if (exitCode !== 0) {
    throw new Error(`create failed (exit ${String(exitCode)})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  const after = await listWorktrees()
  const fresh = after.find((w) => !before.has(w.worktreeId))
  if (!fresh) {
    throw new Error(
      `create reported success but listed no new worktree\n${stdout}\n`
      + `listed: ${JSON.stringify(after)}`,
    )
  }
  return fresh.worktreeId
}

/** Run a tmux command against a worktree's own server. */
async function tmux(id: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-S', sockFor(id), ...args])
  return stdout
}

beforeAll(async () => {
  if (!CAN_RUN) return
  testEnv = await createYaacTestEnv()
  const binDir = path.join(testEnv.scratchDir, 'bin')
  await installFakeAgents(binDir)
  serverEnv = {
    ...testEnv.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // The CLI's create attaches an interactive PTY on success, which hangs
    // without a TTY. Every e2e suite that drives a create sets this.
    YAAC_E2E_NO_ATTACH: '1',
    // The project's "remote" is a local clone; there is nothing to fetch
    // from, and the host-side fetch would try to reach it as a real remote.
    YAAC_E2E_SKIP_FETCH: '1',
  }
  // A create resolves the git identity from the global config; the test env
  // redirects that to its own file, which starts empty.
  await fs.writeFile(
    testEnv.gitConfigPath,
    '[user]\n\tname = Test\n\temail = test@test.com\n',
  )
  server = await spawnYaacServer(serverEnv)

  // A credential has to exist before a create resolves one; the fake is what
  // the auth suites use.
  await runYaac(serverEnv, 'auth', 'fake', 'claude-oauth')
  await runYaac(serverEnv, 'auth', 'fake', 'github')

  repoPath = await createTestRepo(path.join(testEnv.scratchDir, SLUG))
  await addTestProject(repoPath)
  // The clone's origin is the local path it came from, which create refuses
  // to parse as a remote. Point it at a plausible GitHub URL — nothing ever
  // dials it (YAAC_E2E_SKIP_FETCH), and the fake github credential above is
  // what resolves for it.
  await execFileAsync('git', [
    '-C', path.join(testEnv.dataDir, 'projects', SLUG, 'repo'),
    'remote', 'set-url', 'origin', `https://github.com/test/${SLUG}.git`,
  ])
}, 120_000)

afterAll(async () => {
  if (!CAN_RUN) return
  await server.stop()
  await testEnv.cleanup()
})

describe.skipIf(!CAN_RUN)('containerless worktrees (real CLI + real server, no cluster)', () => {
  it('reports the containerless driver on /health, before any credential', async () => {
    const res = await fetch(`${origin()}/health`)
    const body = await res.json() as { driver: string }
    // The CLI reads this to decide whether `yaac cluster …` means anything
    // against this server, so it has to answer unauthenticated.
    expect(body.driver).toBe('containerless')
  })

  it('yaac host check verifies the host instead of a cluster', async () => {
    const { stdout, exitCode } = await runYaac(serverEnv, 'host', 'check')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tmux')
    // The single most important line in the output.
    expect(stdout).toContain('isolation')
  })

  it('yaac cluster check refuses rather than pretending there is a cluster', async () => {
    const { stderr, exitCode } = await runYaac(serverEnv, 'cluster', 'check')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('containerless')
    expect(stderr).toContain('yaac host check')
  })

  it('creates a worktree as a tmux session on this host', async () => {
    worktreeId = await createWorktree()
    // The session really is a tmux server on this host, at the path the
    // driver derives — not a pod, and not the developer's own tmux.
    const windows = await tmux(worktreeId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('claude')
  }, 120_000)

  it('gives the worktree a real checkout on the host, which is what the agent sees', async () => {
    const dir = path.join(
      testEnv.dataDir, 'projects', SLUG, 'worktrees', worktreeId,
    )
    // No path translation: the checkout the server made IS the workspace,
    // which is why the create skips the in-pod gitdir rewrite.
    await expect(fs.stat(path.join(dir, 'README.md'))).resolves.toBeDefined()
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    expect(stdout.trim()).toBe(`agent/${worktreeId}`)
  })

  it('runs the review diff with host git in that checkout', async () => {
    const dir = path.join(
      testEnv.dataDir, 'projects', SLUG, 'worktrees', worktreeId,
    )
    await fs.writeFile(path.join(dir, 'NEW.md'), '# added by the test\n')
    const res = await fetch(`${origin()}/worktree/${worktreeId}/changes`, {
      headers: authHeader(),
    })
    const changes = await res.json() as { files: Array<{ path: string }> }
    expect(changes.files.map((f) => f.path)).toContain('NEW.md')
  })

  it('opens a shell window through the same exec transport the webapp uses', async () => {
    const res = await fetch(`${origin()}/worktree/${worktreeId}/terminals`, {
      method: 'POST',
      headers: authHeader(),
    })
    expect(res.ok).toBe(true)
    const windows = await tmux(worktreeId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('shell')
  })

  it('wires the agent-session discovery hook all the way to the worktree log', async () => {
    // The whole chain, because every link of it is substrate-specific and
    // each fails silently on its own: the command registered in the shared
    // settings.json, the script staged onto the workspace's PATH, and the
    // `$HOME`-relative log reaching this worktree's own file. Registering a
    // command naming an in-image path is what made claude print a
    // SessionStart hook error on every start here.
    const settings = JSON.parse(await fs.readFile(
      path.join(testEnv.dataDir, 'projects', SLUG, 'claude', 'settings.json'), 'utf8',
    )) as { hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> } }
    const commands = settings.hooks?.SessionStart
      ?.flatMap((m) => m.hooks?.map((h) => h.command) ?? []) ?? []
    const command = commands.find((c) => c?.includes('yaac-agent-links'))
    expect(command).toBe('yaac-agent-links "$HOME/.claude" claude')

    const home = path.join(
      testEnv.dataDir, 'projects', SLUG, 'sessions', worktreeId, 'containerless', 'home',
    )
    const binDir = path.join(home, '.local', 'bin')
    await expect(fs.access(path.join(binDir, 'yaac-agent-links'), fs.constants.X_OK))
      .resolves.toBeUndefined()

    // Run the REGISTERED command, unedited, through `sh -c` with the
    // workspace's own PATH and HOME — which is exactly how claude runs it, and
    // the only form that exercises the link the bug was about: resolving a
    // bare name rather than an absolute path that does not exist here. Then
    // read the line back out of the worktree's real log, which the workspace
    // reaches only through the link this driver put in its private home.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh', ['-c', command ?? ''],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            TMUX_PANE: '%7',
          },
        },
        (err) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()),
      )
      child.stdin?.end(JSON.stringify({
        session_id: 'e2e-conv',
        transcript_path: path.join(home, '.claude', 'projects', 'e2e-conv.jsonl'),
      }))
    })

    const log = await fs.readFile(path.join(
      testEnv.dataDir, 'projects', SLUG, 'meta', `${worktreeId}.session-starts.jsonl`,
    ), 'utf8')
    const line = log.trim().split('\n').map((l) => JSON.parse(l) as {
      id: string; tool: string; pane: string; path: string
    }).find((l) => l.id === 'e2e-conv')
    expect(line).toEqual({
      id: 'e2e-conv', tool: 'claude', pane: '7',
      path: path.join('claude', 'projects', 'e2e-conv.jsonl'),
    })
  })

  // Skipped where the adapter happens to BE installed — the refusal is
  // then correctly silent, and there is no way to un-install it for one
  // request (the server's PATH is fixed when it spawns). The logic itself
  // is unit-tested against a mocked PATH; this case is here for the hosts
  // that actually reproduce the defect.
  it.skipIf(ACP_ADAPTER_ON_PATH)(
    'refuses --mode acp with no adapter, before anything is recorded', async () => {
    // The defect this replaces reported SUCCESS and then destroyed the
    // worktree seconds later: acpd exec'd an adapter that ships in the
    // image and is absent from a host, exited 127, and tmux closed the
    // window with the session in it.
    const before = (await listWorktrees()).length
    const { stderr, exitCode } = await runYaac(
      serverEnv, 'worktree', 'create', SLUG, '--tool', 'claude', '--mode', 'acp',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('claude-agent-acp')
    // Nothing was recorded: no running row, and no stopped one either.
    expect(await listWorktrees()).toHaveLength(before)
  }, 60_000)
  /**
   * What a process *inside* the worktree sees: the environment of a live
   * pane, read straight out of `/proc`.
   *
   * Two probes are wrong here and both are worth naming. `show-environment`
   * reports the session environment tmux maintains for FUTURE panes, not the
   * one the server process was started with — which is what panes actually
   * inherit, and what the driver set at launch. And running `printenv` in a
   * new window mutates the fixture every later test shares; it is also what
   * left a tmux server alive through the stop case below.
   */
  async function worktreeEnv(id: string): Promise<Record<string, string>> {
    const pid = (await tmux(id, 'display-message', '-p', '-t', 'yaac', '#{pane_pid}')).trim()
    const raw = await fs.readFile(`/proc/${pid}/environ`, 'utf8')
    const env: Record<string, string> = {}
    // NUL-delimited, and a value may itself contain '='.
    for (const entry of raw.split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return env
  }

  /** The worktree's own yaac-mama credentials, memoized per file. */
  let mamaEnv: Record<string, string> | undefined
  const mamaCreds = async (): Promise<Record<string, string>> =>
    (mamaEnv ??= await worktreeEnv(worktreeId))

  /**
   * `yaac-mama` as the worktree would run it, over the transport that only
   * exists here: no proxy to queue the request, so it posts straight to the
   * server with the bearer its launch put in its environment. Handed exactly
   * the two variables the worktree itself was given, so nothing the test
   * knows can stand in for them.
   */
  async function runMama(...args: string[]): Promise<{ code: number; out: string }> {
    const creds = await mamaCreds()
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `YAAC_MAMA_URL='${creds.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${creds.YAAC_MAMA_TOKEN}' `
      + `${path.join(process.cwd(), 'worktree-bin', 'yaac-mama')} ${quoted} 2>&1; echo "EXIT:$?"`,
    ])
    const m = /EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker:\n${stdout}`)
    return { code: Number(m[1]), out: stdout.slice(0, m.index) }
  }

  it('hands the worktree a yaac-mama credential and server address', async () => {
    const creds = await mamaCreds()
    expect(creds.YAAC_MAMA_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(creds.YAAC_MAMA_TOKEN).toBeTruthy()
    // A bearer of its own, never the server's secret — holding that would
    // give the worktree the whole CLI rather than the subset.
    expect(creds.YAAC_MAMA_TOKEN).not.toBe(server.lock.secret)
    expect(Object.values(creds)).not.toContain(server.lock.secret)
  })

  it('lists this project’s sessions from inside the worktree', async () => {
    const { code, out } = await runMama('list')
    expect(code).toBe(0)
    expect(out).toMatch(/SESSION\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
    // Attributed by the token alone: the request never names a worktree, and
    // the row it marks is the caller's.
    expect(out).toContain(`${worktreeId.slice(0, 8)} (you)`)
  })

  it('makes a group and files itself into it, without a proxy anywhere', async () => {
    const made = await runMama('group', 'create', 'nightly')
    expect(made.code).toBe(0)

    const moved = await runMama('group', 'move', worktreeId.slice(0, 8), 'nightly')
    expect(moved.code).toBe(0)

    // Read back through the ordinary API: what the command channel wrote is
    // the same state the sidebar renders.
    const res = await fetch(`${origin()}/worktree/group/list?project=${SLUG}`, {
      headers: authHeader(),
    })
    const { groups } = await res.json() as { groups: Array<{ groupId: string; name: string }> }
    expect(groups.map((g) => g.name)).toContain('nightly')

    const listed = await runMama('list')
    expect(listed.out).toMatch(new RegExp(`${worktreeId.slice(0, 8)}[^\\n]*nightly`))
  })

  it('renames itself, which the server records against the caller\u2019s own id', async () => {
    // No session named: the token alone says who is asking, so an agent can
    // label itself without knowing its own id.
    const renamed = await runMama('rename', 'wiring up the mama channel')
    expect(renamed.code).toBe(0)
    expect(renamed.out).toContain('wiring up the mama channel')

    // Read back through the ordinary API — one title, one piece of state.
    const res = await fetch(`${origin()}/worktree/list?project=${SLUG}`, {
      headers: authHeader(),
    })
    const body = await res.json() as { worktrees: Array<{ worktreeId: string; title?: string }> }
    const mine = body.worktrees.find((w) => w.worktreeId === worktreeId)
    expect(mine?.title).toBe('wiring up the mama channel')
  })

  it('attributes a request to the token\u2019s OWN worktree, not the one asking', async () => {
    // The security property the whole design rests on: a request never names
    // a worktree, so the token is the only thing that says who is calling.
    // Proving it needs a second worktree — one token, run with no session
    // argument, must retitle ITS worktree and leave the other alone.
    const otherId = await createWorktree()
    try {
      const theirs = await worktreeEnv(otherId)
      expect(theirs.YAAC_MAMA_TOKEN).not.toBe((await mamaCreds()).YAAC_MAMA_TOKEN)

      const res = await fetch(`${origin()}/worktree/mama`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${theirs.YAAC_MAMA_TOKEN}`,
        },
        body: JSON.stringify({ command: 'rename', args: {}, body: 'named by its own token' }),
      })
      expect(res.status).toBe(200)

      const listed = await fetch(`${origin()}/worktree/list?project=${SLUG}`, {
        headers: authHeader(),
      })
      const body = await listed.json() as {
        worktrees: Array<{ worktreeId: string; title?: string }>
      }
      const byId = new Map(body.worktrees.map((w) => [w.worktreeId, w.title]))
      expect(byId.get(otherId)).toBe('named by its own token')
      // The caller of every other case in this file is untouched: holding a
      // token gets you that worktree and no other.
      expect(byId.get(worktreeId)).not.toBe('named by its own token')
    } finally {
      await runYaac(serverEnv, 'worktree', 'stop', otherId)
    }
  }, 120_000)

  it('refuses a command outside the allowlist, and an unknown token', async () => {
    const denied = await runMama('delete', worktreeId)
    expect(denied.code).toBe(2)
    expect(denied.out).toContain('unknown command')

    // An empty session argument is a usage error, not a self-stop: it never
    // leaves the script, so this is safe to run against the live subject.
    // `stop "$id"` with $id unset is a caller that meant to name a sibling,
    // and falling through to the default would stop THIS worktree instead.
    const empty = await runMama('stop', '')
    expect(empty.code).toBe(2)
    expect(empty.out).toContain('omit the session to stop yourself')

    // Straight at the route, past the script: the server refuses the same
    // command, and refuses a caller it cannot identify.
    const post = async (token: string, command: string): Promise<number> => {
      const res = await fetch(`${origin()}/worktree/mama`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command, args: {}, body: 'x' }),
      })
      return res.status
    }
    const token = (await mamaCreds()).YAAC_MAMA_TOKEN
    expect(await post(token, 'delete')).toBe(422)
    expect(await post('not-a-real-token', 'list')).toBe(401)
    // The server's own secret is not a yaac-mama credential either.
    expect(await post(server.lock.secret, 'list')).toBe(401)
  })

  it('stops a session it names, and stops ITSELF when it names none', async () => {
    // Its own subject, because both halves destroy one — and the second half
    // destroys the very worktree it is running in, which is the whole point:
    // under this driver the tmux server hosting the command IS the unit the
    // stop takes down.
    const doomed = await createWorktree()
    const theirs = await worktreeEnv(doomed)
    const asDoomed = async (...args: string[]): Promise<{ code: number; out: string }> => {
      const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
      const { stdout } = await execFileAsync('sh', ['-c',
        `YAAC_MAMA_URL='${theirs.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${theirs.YAAC_MAMA_TOKEN}' `
        + `${path.join(process.cwd(), 'worktree-bin', 'yaac-mama')} ${quoted} 2>&1; echo "EXIT:$?"`,
      ])
      const m = /EXIT:(\d+)\s*$/.exec(stdout)
      if (!m) throw new Error(`no exit marker:\n${stdout}`)
      return { code: Number(m[1]), out: stdout.slice(0, m.index) }
    }

    // A session it cannot see is refused rather than half-resolved.
    const missing = await asDoomed('stop', 'no-such-session')
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('no session')

    // No session named: the token says who is asking, and the answer is the
    // caller. Its reply may not survive its own teardown, so what is
    // asserted is the tmux server going away — the contract the skill
    // states, rather than the line it hopes to print.
    await asDoomed('stop').catch(() => undefined)
    let gone = false
    for (let i = 0; i < 60 && !gone; i++) {
      gone = await tmux(doomed, 'has-session', '-t', 'yaac').then(() => false, () => true)
      if (!gone) await new Promise((r) => setTimeout(r, 1_000))
    }
    expect(gone).toBe(true)
    // A stop, not a delete: the checkout it was working in is still there.
    await expect(fs.stat(
      path.join(testEnv.dataDir, 'projects', SLUG, 'worktrees', doomed),
    )).resolves.toBeDefined()
  }, 180_000)

  it('offers yaac\'s builtin skills where the agent\'s own HOME looks for them', async () => {
    // The delivery a pod does with a read-only mount over each tool home. No
    // mount namespace here, so the skills are linked into the project's
    // shared roots — and what proves it is reading them the way the agent
    // does: through the workspace HOME the launch built, whose `.claude` is
    // itself a link into that shared dir.
    const entries = await fs.readdir(builtinSkillsDir(), { withFileTypes: true })
    const names: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const hasSkill = await fs.access(path.join(builtinSkillsDir(), e.name, 'SKILL.md'))
        .then(() => true, () => false)
      if (hasSkill) names.push(e.name)
    }
    expect(names.length).toBeGreaterThan(0)

    const home = workspaceHome(SLUG, worktreeId)
    for (const name of names) {
      const viaHome = path.join(home, '.claude', 'skills', name, 'SKILL.md')
      expect(await fs.readFile(viaHome, 'utf8')).toContain('---')
    }
    // Linked, not copied, in every tool's root: an upgrade of the install
    // moves every worktree of the project at once, whichever tool it runs,
    // with nothing staged that could go stale. The target is the SERVER's
    // own install — this suite drives a built CLI, whose package root is not
    // the one this test process resolves — so the shape is what is asserted.
    for (const root of sharedSkillRoots(SLUG)) {
      const target = await fs.readlink(path.join(root, names[0]))
      expect(target.endsWith(path.join('builtin-skills', names[0]))).toBe(true)
      await expect(fs.access(path.join(target, 'SKILL.md'))).resolves.toBeUndefined()
    }
  })

  // Destroys its subject — keep last.
  it('stops the worktree by taking its tmux server down', async () => {
    const { exitCode } = await runYaac(serverEnv, 'worktree', 'stop', worktreeId)
    expect(exitCode).toBe(0)
    // The tmux server is the unit: when it is gone the worktree is gone,
    // and nothing is left holding the checkout.
    await expect(tmux(worktreeId, 'has-session', '-t', 'yaac')).rejects.toThrow()
  }, 60_000)

  it('leaves the checkout behind, and stays stopped rather than flickering back', async () => {
    const dir = path.join(
      testEnv.dataDir, 'projects', SLUG, 'worktrees', worktreeId,
    )
    await expect(fs.stat(dir)).resolves.toBeDefined()

    // A detached teardown cannot reach this driver's registry, and a
    // workspace it never forgot is handed to the stale reaper on every
    // pass — the row reappearing as "stopping…" every other minute, for
    // as long as the server runs.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1_000))
      expect((await listWorktrees()).map((w) => w.worktreeId)).not.toContain(worktreeId)
    }
  }, 60_000)

  // And it really restarts — the assertion above used to stop at "the
  // checkout is still there", which is exactly where the defect hid: the
  // driver's own node_modules symlink tripped the ephemeral-modules guard,
  // so every stopped worktree was permanently unrestartable.
  it('restarts the stopped worktree back onto a live tmux server', async () => {
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'worktree', 'restart', worktreeId,
    )
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    const windows = await tmux(worktreeId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('claude')
    await runYaac(serverEnv, 'worktree', 'stop', worktreeId)
  }, 180_000)
})

// Runs last in the file: it replaces the shared server, and the worktree it
// creates is the one it then recovers.
describe.skipIf(!CAN_RUN)('containerless recovery across a server restart', () => {
  it('re-adopts a worktree whose tmux server outlived the server that made it', async () => {
    const id = await createWorktree()

    // A real restart: the old server process goes away entirely and a new
    // one comes up on the same data dir. Driven from the fixture rather
    // than through `yaac server restart` so `server` keeps naming the
    // process this file is talking to (and the one afterAll stops).
    await server.stop()
    server = await spawnYaacServer(serverEnv)

    // The whole premise of the design: restarting yaac must not stop
    // anyone's agent.
    await expect(tmux(id, 'has-session', '-t', 'yaac')).resolves.toBeDefined()

    // And the new server has to KNOW about it — recovered from the markers
    // on disk, since nothing else on a host records that a worktree exists.
    // Polled because the recovery scan runs as the driver attaches, which is
    // after the server is answering: a client that connects in that window
    // sees the worktrees appear rather than being made to wait for them.
    await vi.waitFor(
      async () => expect((await listWorktrees()).map((w) => w.worktreeId)).toContain(id),
      { timeout: 20_000, interval: 250 },
    )

    await runYaac(serverEnv, 'worktree', 'stop', id)
  }, 180_000)
})

/**
 * `yaac worktree create --group`, which no other tier drives: the k8s suite
 * reaches the same server code through `yaac-mama create --group`, but the
 * FLAG's own path — parse, into the create body, resolved before anything is
 * provisioned — is only exercised here. Containerless because a real create
 * costs a second here and a pod elsewhere.
 */
describe.skipIf(!CAN_RUN)('yaac worktree create --group', () => {
  it('creates the named group and files the new worktree into it', async () => {
    const before = new Set((await listWorktrees()).map((w) => w.worktreeId))
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'worktree', 'create', SLUG, '--tool', 'claude', '--group', 'friday batch',
    )
    if (exitCode !== 0) {
      throw new Error(`create failed (exit ${String(exitCode)})\n${stdout}\n${stderr}`)
    }
    const fresh = (await listWorktrees()).find((w) => !before.has(w.worktreeId))
    expect(fresh).toBeDefined()

    // The group was created by name — the caller was naming one, not picking
    // it from a list they could see.
    const res = await fetch(`${origin()}/worktree/group/list?project=${SLUG}`, {
      headers: authHeader(),
    })
    const { groups } = await res.json() as { groups: Array<{ groupId: string; name: string }> }
    const made = groups.find((g) => g.name === 'friday batch')
    expect(made).toBeDefined()

    // And the worktree is IN it, which is the half a create could silently
    // skip: the filing happens as the row is written, not when provisioning
    // finishes.
    const listed = await runYaac(serverEnv, 'worktree', 'list', SLUG)
    expect(listed.stdout).toMatch(new RegExp(`${fresh!.worktreeId.slice(0, 8)}[^\\n]*friday batch`))

    await runYaac(serverEnv, 'worktree', 'stop', fresh!.worktreeId)
  }, 180_000)
})

/**
 * An agent that is installed but cannot run — the launch failure no PATH
 * check predicts, and the one that used to be completely silent.
 *
 * Last in the file: its subject is a worktree that dies on purpose.
 */
describe.skipIf(!CAN_RUN)('an agent that dies the moment it launches', () => {
  it('reports it as a failed provisioning row instead of a worktree that vanishes', async () => {
    const watch = collectSnapshots(server.lock.port, server.lock.secret)
    await watch.opened
    try {
      // The fake codex exits 127, so tmux closes the window the instant it
      // is respawned — and `respawn-window` still reports success, which is
      // the whole defect: before this the create said it worked and the
      // worktree was gone seconds later with nothing said.
      const { exitCode } = await runYaac(
        serverEnv, 'worktree', 'create', SLUG, '--tool', 'codex',
      )
      // The create itself does NOT fail, and that is deliberate: the probe
      // is not awaited, so its settle delay never lands on a create's wall
      // clock. The verdict arrives just behind it.
      expect(exitCode).toBe(0)

      await vi.waitFor(() => {
        const row = watch.latest()?.provisioning.find((p) => p.tool === 'codex' && p.error)
        expect(row?.error).toMatch(/exited right after launch/)
        // Containerless, so the row also names what to check — the failure
        // is nearly always a tool this host cannot actually run.
        expect(row?.error).toMatch(/npm install -g @openai\/codex/)
      }, { timeout: 30_000, interval: 250 })
    } finally {
      watch.ws.close()
    }
  }, 180_000)
})
