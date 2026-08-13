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
import {
  containerlessJobName,
  containerlessWorkspacePaths,
} from '@yaac/server/drivers/containerless/paths'

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
 */
async function installFakeAgents(binDir: string): Promise<void> {
  await fs.mkdir(binDir, { recursive: true })
  for (const tool of ['claude', 'codex', 'opencode', 'pi']) {
    const file = path.join(binDir, tool)
    await fs.writeFile(file, '#!/bin/sh\nexec sleep infinity\n')
    await fs.chmod(file, 0o755)
  }
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
