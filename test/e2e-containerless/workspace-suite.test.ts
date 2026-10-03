import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import http from 'node:http'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  TEST_CLI_ENTRY,
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { assignTestGitCredential } from '@yaac/test-utils/api'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'
import { createTestRepo, addTestProject } from '@yaac/test-utils/setup'
import { collectSnapshots } from '@yaac/test-utils/events-ws'
import {
  containerlessJobName,
  containerlessWorkspacePaths,
  workspaceHome,
} from '@yaac/server/drivers/containerless/paths'
import { builtinSkillsDir, sharedSkillRoots } from '@yaac/server/domain/skills'
import { defaultModelFor } from '@yaac/server/domain/auth'
import { AGENT_PACKAGES, agentPackagePrefix } from '@yaac/shared/tool-install'
import { ACP_ADAPTERS, AGENT_TOOLS } from '@yaac/shared/types'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { FALLBACK_MODELS, PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'
import type { AgentSessionEntry, AgentTool, ServerSnapshot, WorkspaceTerminalEntry } from '@yaac/shared/types'

const execFileAsync = promisify(execFile)

/**
 * The containerless driver end to end: the real CLI against a real server
 * that runs workspaces as tmux sessions on this host
 * (docs/containerless-driver.md). No cluster, images or proxy, so the file
 * is fast and runs in parallel with others.
 *
 * One test env, server and workspace are shared by the read-only cases;
 * tests that destroy their subject run last.
 *
 * The host needs `tmux` and `git`. Agent CLIs are faked, staged where yaac
 * installs the pinned ones: the launch, exec, port scan and recovery under
 * test do not depend on the agent, and a real one would need credentials.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer
let serverEnv: NodeJS.ProcessEnv
let repoPath: string
let workspaceId: string

const SLUG = 'cl-demo'
/** The project's git credential: an HTTPS token, assigned in beforeAll. */
const GIT_TOKEN = 'ghp_containerless_test'
/**
 * The server's starting grace, shortened so the stale reaper takes a dead
 * workspace on the pass its stream drop triggers rather than a minute later.
 */
const STARTING_GRACE_MS = 5_000

/** Whether this host has the binaries `yaac host check` requires. */
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

/**
 * Whether this host can run the acp cases. The adapter is faked, but the
 * chat transport needs a real `socat` to reach acpd's socket.
 */
const CAN_RUN_ACP = CAN_RUN
  && await execFileAsync('sh', ['-c', 'command -v socat']).then(() => true, () => false)

/** Whether port detection works here: it uses `lsof`, and reports nothing without it. */
const CAN_RUN_PORTS = CAN_RUN
  && await execFileAsync('sh', ['-c', 'command -v lsof']).then(() => true, () => false)

/**
 * A fake codex that mimics what yaac sees from codex-cli. On the first
 * prompt it reports the conversation (with its rollout path) through the
 * SessionStart hook, then the throwaway title session (no rollout). A resume
 * reports nothing. Each launch's arguments are logged per workspace for the
 * restart case. With `--model sick` it fails to start.
 *
 * It calls the hook script directly; that real codex runs it is checked
 * against the pinned binary (see `ensureAgentReporters`).
 */
const FAKE_CODEX = [
  '#!/bin/sh',
  'case " $* " in *" --model sick "*) echo "codex: cannot execute" >&2; exit 127 ;; esac',
  'printf \'%s\\n\' "$*" >> "$CODEX_HOME/launches-${PWD##*/}"',
  // The alternate screen is the readiness signal the prompt paste waits for.
  "printf '\\033[?1049h'",
  'case " $* " in *" resume "*) exec sleep infinity ;; esac',
  'read -r _ || exec sleep infinity',
  'mkdir -p "$CODEX_HOME/sessions"',
  'rollout="$CODEX_HOME/sessions/rollout-thread-$$.jsonl"',
  ': > "$rollout"',
  'printf \'{"session_id":"thread-%s","transcript_path":"%s"}\' $$ "$rollout" | yaac-agent-links "$CODEX_HOME" codex',
  'printf \'{"session_id":"title-%s","transcript_path":null}\' $$ | yaac-agent-links "$CODEX_HOME" codex',
  'exec sleep infinity',
  '',
].join('\n')

/** Where the server finds yaac's own install of `binary`. */
const managedBin = (binary: string): string =>
  path.join(agentPackagePrefix(AGENT_PACKAGES[binary]), 'bin', binary)

/**
 * Stage fake agents where yaac installs the pinned ones, so create installs
 * nothing. Each holds its tmux window open like a real TUI; otherwise the
 * window, and with it the workspace, would end at once. `codex` is
 * `FAKE_CODEX`.
 *
 * ACP adapters are faked too (`fakeAcpAdapter`), one per adapter binary.
 * opencode's adapter is its CLI's `acp` subcommand, so its fake is both.
 */
async function installFakeAgents(): Promise<void> {
  // `dir`: the binary whose install dir the file goes in.
  const write = async (name: string, body: string, dir = name): Promise<string> => {
    const file = path.join(path.dirname(managedBin(dir)), name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
    await fs.chmod(file, 0o755)
    return file
  }
  for (const tool of ['claude', 'pi']) {
    await write(tool, '#!/bin/sh\nexec sleep infinity\n')
  }
  await write('codex', FAKE_CODEX)

  for (const tool of AGENT_TOOLS) {
    const { binary } = ACP_ADAPTERS[tool]
    if (binary === tool) continue
    await write(binary, fakeAcpAdapter(tool))
  }
  // `exec` so the adapter itself owns acpd's stdio.
  await write('opencode-acp-impl', fakeAcpAdapter('opencode'), 'opencode')
  await write(
    'opencode',
    '#!/bin/sh\n'
    + 'if [ "$1" = "acp" ]; then shift; exec opencode-acp-impl "$@"; fi\n'
    + 'exec sleep infinity\n',
  )
}

/**
 * The modes each fake ACP adapter advertises: the ones yaac maps postures
 * onto. The real adapters are checked against these at their pinned
 * versions (workspace-create-suite).
 */
const ACP_MODES: Record<AgentTool, { current: string; available: string[] }> = {
  claude: { current: 'default', available: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  // codex-acp's real default. Getting it wrong would change whether
  // `applyPermissionMode` sends a switch at all.
  codex: { current: 'agent', available: ['read-only', 'workspace-write', 'agent', 'agent-full-access'] },
  opencode: { current: 'build', available: ['build', 'plan'] },
  // pi advertises thinking levels, which yaac never sets.
  pi: { current: 'medium', available: ['off', 'medium', 'high'] },
}

/**
 * The `session/new` mode fields, in each adapter's own format. opencode v2
 * sends only `configOptions` (a `mode` select), which `acpModeOffered`
 * handles; the others send `modes`.
 */
function sessionModesReply(tool: AgentTool): Record<string, unknown> {
  const { current, available } = ACP_MODES[tool]
  // claude's adapter uses its own model values in the picker.
  const model = tool === 'claude'
    ? { id: 'model', currentValue: 'opus[1m]', options: [{ value: 'opus[1m]', name: 'Opus 5.5' }] }
    : { id: 'model', currentValue: 'e2e-model' }
  if (tool === 'opencode') {
    return {
      configOptions: [
        model,
        { id: 'mode', currentValue: current, options: available.map((value) => ({ value })) },
      ],
    }
  }
  return {
    modes: { currentModeId: current, availableModes: available.map((id) => ({ id })) },
    configOptions: [model],
  }
}

/** A marker file that makes the fake adapters exit before the handshake. */
const ACP_ADAPTER_DIES = 'acp-adapter-dies'

/**
 * A prompt that makes the fake adapters switch themselves into plan mode
 * (as claude's EnterPlanMode does), or into any mode as `enter <id> mode`.
 */
const ENTER_PLAN_MODE = 'enter plan mode'

/**
 * A fake ACP adapter: line-delimited JSON-RPC on stdio that answers the
 * handshake and little else. Its session id names the tool, and it reports
 * its `cwd` to show acpd spawned it in the checkout.
 */
const fakeAcpAdapter = (tool: AgentTool): string => `#!/usr/bin/env node
if (require('fs').existsSync(require('path').join(__dirname, '${ACP_ADAPTER_DIES}'))) process.exit(1)
let buf = ''
const reply = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: false } })
    } else if (msg.method === 'session/new') {
      reply(msg.id, {
        sessionId: 'e2e-acp-${tool}',
        cwd: process.cwd(),
        ...${JSON.stringify(sessionModesReply(tool))},
      })
    } else if (msg.method === 'session/prompt' && /enter \\w+ mode/.test(JSON.stringify(msg.params))) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: /enter (\\w+) mode/.exec(JSON.stringify(msg.params))[1],
        },
      } }) + '\\n')
      reply(msg.id, { stopReason: 'end_turn' })
    } else {
      reply(msg.id, {})
    }
  }
})
process.stdin.resume()
`

/** The spawned server's origin (a per-worker port). */
const origin = (): string => `http://127.0.0.1:${String(server.lock.port)}`

/** The tmux socket the driver uses for a workspace. */
function sockFor(id: string): string {
  return containerlessWorkspacePaths(containerlessJobName(SLUG, id)).tmuxSock
}

interface ListedWorkspace {
  workspaceId: string
  status: string
  title?: string
  groupId?: string
  forwardedPorts: Array<{ containerPort: number; hostPort: number }>
  agentSessions: AgentSessionEntry[]
  terminals?: WorkspaceTerminalEntry[]
}

/** The workspaces the server currently reports, newest first. */
async function listWorkspaces(): Promise<ListedWorkspace[]> {
  const res = await fetch(`${origin()}/api/workspace/list`)
  const body = await res.json() as { workspaces: ListedWorkspace[] }
  return body.workspaces
}

/** Run `yaac forward` as a long-lived child, with a wait for its listener. */
function startForwardCli(...args: string[]): {
  ready: (timeoutMs?: number) => Promise<void>
  output: () => string
  stop: () => Promise<void>
} {
  const child = spawn(process.execPath, [TEST_CLI_ENTRY, 'forward', ...args], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
  child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8') })
  return {
    output: () => out,
    ready: async (timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (!out.includes('forwarding ')) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`yaac forward never bound its port. Output:\n${out}`)
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
    },
  }
}

/**
 * Create a claude workspace and return its id, read from the server's
 * listing since the CLI prints none for a tui workspace.
 */
async function createWorkspace(...extra: string[]): Promise<string> {
  return createWorkspaceWith('claude', ...extra)
}

/** `createWorkspace` for a given tool, in `tui` unless `extra` names a mode. */
async function createWorkspaceWith(tool: string, ...extra: string[]): Promise<string> {
  return (await createWorkspaceFrom('--tool', tool, '--mode', 'tui', ...extra)).workspaceId
}

/** Run `yaac workspace create` with exactly `args`; the new id and stdout. */
async function createWorkspaceFrom(...args: string[]): Promise<{ workspaceId: string; stdout: string }> {
  const before = new Set((await listWorkspaces()).map((w) => w.workspaceId))
  const { stdout, stderr, exitCode } = await runYaac(cliEnv(), 'workspace', 'create', SLUG, ...args)
  if (exitCode !== 0) {
    throw new Error(`create failed (exit ${String(exitCode)})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  const after = await listWorkspaces()
  const fresh = after.find((w) => !before.has(w.workspaceId))
  if (!fresh) {
    throw new Error(
      `create reported success but listed no new workspace\n${stdout}\n`
      + `listed: ${JSON.stringify(after)}`,
    )
  }
  return { workspaceId: fresh.workspaceId, stdout }
}

/** The zone the CLI reports at create, unlike the server's own `TZ`. */
const CLI_TIME_ZONE = 'Pacific/Auckland'

/**
 * The CLI's environment: a device in `CLI_TIME_ZONE`, and not inside a
 * workspace (which this suite may itself run in), so it reports its zone.
 */
function cliEnv(): NodeJS.ProcessEnv {
  return { ...serverEnv, TZ: CLI_TIME_ZONE, YAAC_WORKSPACE_ID: undefined, YAAC_WORKTREE_ID: undefined }
}

/** Run a tmux command against a workspace's own server. */
async function tmux(id: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-S', sockFor(id), ...args])
  return stdout
}

/** A variable from the workspace tmux server's environment, which every pane inherits. */
async function workspaceEnvVar(id: string, name: string): Promise<string> {
  const line = (await tmux(id, 'show-environment', '-g', name)).trim()
  return line.startsWith(`${name}=`) ? line.slice(name.length + 1) : ''
}

beforeAll(async () => {
  if (!CAN_RUN) return
  testEnv = await createYaacTestEnv()
  await installFakeAgents()
  serverEnv = {
    ...testEnv.env,
    // Create would otherwise attach a PTY and hang without a TTY.
    YAAC_E2E_NO_ATTACH: '1',
    // The project's remote is fake; skip the fetch.
    YAAC_E2E_SKIP_FETCH: '1',
    // Bogus tool homes in the server's own environment, which agents must
    // not inherit (checked by the tool-home case below).
    CLAUDE_CONFIG_DIR: '/nowhere/claude',
    CODEX_HOME: '/nowhere/codex',
    PI_CODING_AGENT_DIR: '/nowhere/pi',
    OPENCODE_CONFIG_DIR: '/nowhere/opencode',
    XDG_CONFIG_HOME: '/nowhere/config',
    XDG_DATA_HOME: '/nowhere/share',
    // As if an agent had started this server from its Bash tool.
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent',
    GIT_EDITOR: 'true',
    YAAC_STARTING_GRACE_MS: String(STARTING_GRACE_MS),
    // A host zone the workspace must not inherit (checked by the time-zone
    // case below).
    TZ: 'UTC',
  }
  server = await spawnYaacServer(serverEnv)

  // Create needs a tool credential.
  await runYaac(serverEnv, 'auth', 'fake', 'claude-oauth')

  repoPath = await createTestRepo(path.join(testEnv.scratchDir, SLUG))
  // A local path is refused as a remote, so use a GitHub URL that is never
  // fetched, with a git credential assigned.
  await addTestProject(server, repoPath, { remoteUrl: `https://github.com/test/${SLUG}.git` })
  await assignTestGitCredential(server, SLUG, GIT_TOKEN)
})

afterAll(async () => {
  if (!CAN_RUN) return
  // Optional chaining keeps a beforeAll failure from being hidden by a
  // TypeError here.
  await server?.stop()
  await testEnv?.cleanup()
})

describe.skipIf(!CAN_RUN)('containerless workspaces (real CLI + real server, no cluster)', () => {
  it('reports the containerless driver on /health, before any credential', async () => {
    const res = await fetch(`${origin()}/api/health`)
    const body = await res.json() as { driver: string }
    // The CLI reads this to decide whether `yaac cluster` applies, so it
    // needs no credential.
    expect(body.driver).toBe('containerless')
  })

  it('yaac host check verifies the host instead of a cluster', async () => {
    const { stdout, exitCode } = await runYaac(serverEnv, 'host', 'check')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tmux')
    // The warning that workspaces are not isolated.
    expect(stdout).toContain('isolation')
  })

  it('yaac cluster check refuses rather than pretending there is a cluster', async () => {
    const { stderr, exitCode } = await runYaac(serverEnv, 'cluster', 'check')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('containerless')
    expect(stderr).toContain('yaac host check')
  })

  it('yaac config git-identity shows and sets the identity a create commits under', async () => {
    // Create refuses without an identity, so this runs before the first one.
    const unset = await runYaac(serverEnv, 'config', 'git-identity')
    expect(unset.exitCode).toBe(0)
    expect(unset.stdout).toContain('No git identity is set')

    // Both parts are required.
    const half = await runYaac(serverEnv, 'config', 'git-identity', '--name', 'Test')
    expect(half.exitCode).toBe(1)
    expect(half.stderr).toContain('--name and --email')

    const set = await runYaac(
      serverEnv, 'config', 'git-identity', '--name', 'Test', '--email', 'test@test.com',
    )
    expect(set.exitCode).toBe(0)
    expect(set.stdout).toContain('Git identity: Test <test@test.com>')
    expect((await runYaac(serverEnv, 'config', 'git-identity')).stdout)
      .toContain('Test <test@test.com>')
  })

  it('creates a workspace as a tmux session on this host', async () => {
    workspaceId = await createWorkspace()
    // A tmux server of its own on this host.
    const windows = await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('claude')
    // The agent keeps the session's first pane, so its history limit must be
    // set before the session exists: it is the scrollback the webapp seeds.
    expect((await tmux(workspaceId, 'display', '-p', '-t', 'yaac:claude', '#{history_limit}')).trim()).toBe('200000')

    // Every create picks a model (the fallback here, nothing remembered
    // yet); the fake agent reports nothing, so this comes from the launch.
    const res = await fetch(`${origin()}/api/workspace/list`)
    const { workspaces } = await res.json() as {
      workspaces: Array<{ workspaceId: string; agentSessions: AgentSessionEntry[] }>
    }
    expect(workspaces.find((w) => w.workspaceId === workspaceId)?.agentSessions[0])
      .toMatchObject({ model: FALLBACK_MODELS.claude, modelName: 'Opus 5.5' })
  }, 120_000)

  it('launches the workspace in the zone the CLI reported, not the server host\'s', async () => {
    const res = await fetch(`${origin()}/api/config/time-zone`)
    expect(await res.json()).toEqual({ timeZone: CLI_TIME_ZONE, pinned: false })
    expect((await workspaceEnv(workspaceId)).TZ).toBe(CLI_TIME_ZONE)
  })

  it('gives the workspace a real checkout on the host, which is what the agent sees', async () => {
    const dir = path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId,
    )
    // The server's checkout is the workspace itself.
    await expect(fs.stat(path.join(dir, 'README.md'))).resolves.toBeDefined()
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    expect(stdout.trim()).toBe(`agent/${workspaceId}`)
    // Its own clone, borrowing objects from the main clone.
    expect((await fs.stat(path.join(dir, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8'))
      .toBe(`${path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'repo', '.git', 'objects')}\n`)
  })

  it('runs the review diff with host git in that checkout', async () => {
    const dir = path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId,
    )
    await fs.writeFile(path.join(dir, 'NEW.md'), '# added by the test\n')
    const res = await fetch(`${origin()}/api/workspace/${workspaceId}/changes`)
    const changes = await res.json() as { files: Array<{ path: string }> }
    expect(changes.files.map((f) => f.path)).toContain('NEW.md')
  })

  it('edits the checkout over HTTP: create, list, read, a stale save refused, then saved', async () => {
    const api = (route: string, init: RequestInit = {}): Promise<Response> => fetch(
      `${origin()}/api/workspace/${workspaceId}${route}`,
      { ...init, headers: { 'content-type': 'application/json' } },
    )
    const put = (body: object): Promise<Response> => api('/file', { method: 'PUT', body: JSON.stringify(body) })

    // A save with no base creates the file and its folders.
    const created = await put({ path: 'notes/todo.md', content: 'one\n', baseVersion: null })
    expect(created.status).toBe(200)
    const { version } = await created.json() as { version: string }
    expect((await put({ path: '.gitignore', content: 'node_modules/\n', baseVersion: null })).status).toBe(200)
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId)
    await fs.mkdir(path.join(checkout, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(checkout, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const files = await (await api('/files')).json() as {
      paths: string[]; ignored: string[]; status: Record<string, string>
    }
    expect(files.paths).toEqual(expect.arrayContaining(['README.md', 'notes/todo.md']))
    expect(files.ignored).toContain('node_modules/')
    expect(files.status['notes/todo.md']).toBe('untracked')

    const read = await (await api('/file?path=notes/todo.md')).json() as { version: string; content: string }
    expect(read).toMatchObject({ version, content: 'one\n' })

    // After an outside write, a save against the old version is refused
    // with the current version.
    await fs.writeFile(path.join(checkout, 'notes', 'todo.md'), 'theirs\n')
    const stale = await put({ path: 'notes/todo.md', content: 'mine\n', baseVersion: version })
    expect(stale.status).toBe(409)
    const { version: current } = await stale.json() as { version: string }
    expect(await fs.readFile(path.join(checkout, 'notes', 'todo.md'), 'utf8')).toBe('theirs\n')
    expect((await put({ path: 'notes/todo.md', content: 'mine\n', baseVersion: current })).status).toBe(200)
    expect(await fs.readFile(path.join(checkout, 'notes', 'todo.md'), 'utf8')).toBe('mine\n')
    // An oversized body is refused before it is buffered: on its declared
    // length alone, so only the headers are sent. Writing the body would race
    // the server dropping the connection, failing the write with EPIPE.
    const huge = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${origin()}/api/workspace/${workspaceId}/file`, {
        method: 'PUT',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) },
      }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
        req.destroy()
      })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(huge).toBe(413)

    const dir = await (await api('/dir?path=node_modules')).json() as { entries: Array<{ name: string; dir: boolean }> }
    expect(dir.entries).toEqual([{ name: 'pkg', dir: true }])
  })

  it('gives the workspace\'s own git the project\'s credential', async () => {
    // The checkout's `origin` has no token and the private HOME hides the
    // user's git config, so real git must get the credential from the
    // config the create wrote.
    const home = workspaceHome(SLUG, workspaceId)
    const dir = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId)
    // Read from the workspace's tmux environment, which also shows the
    // launch set it. The host's own GIT_CONFIG_GLOBAL would otherwise leak in.
    const gitConfigGlobal = await workspaceEnvVar(workspaceId, 'GIT_CONFIG_GLOBAL')
    expect(gitConfigGlobal).toBe(path.join(home, '.gitconfig'))
    const filled = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git', ['credential', 'fill'],
        {
          cwd: dir,
          // GIT_CONFIG_GLOBAL picks the config; HOME locates the credential
          // store. No prompt, so a failure fails instead of hanging.
          env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_GLOBAL: gitConfigGlobal,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
        (err, stdout) => (err
          ? reject(err instanceof Error ? err : new Error('git credential fill failed'))
          : resolve(stdout)),
      )
      child.stdin?.end('protocol=https\nhost=github.com\n\n')
    })
    expect(filled).toContain('username=x-access-token')
    // The real token: there is no proxy to swap in a placeholder
    // (docs/containerless-driver.md).
    expect(filled).toContain(`password=${GIT_TOKEN}`)
  })

  it('opens and kills a shell window, and the listing follows both', async () => {
    const res = await fetch(`${origin()}/api/workspace/${workspaceId}/terminals`, {
      method: 'POST',
    })
    expect(res.ok).toBe(true)
    const shell = await res.json() as WorkspaceTerminalEntry
    const windows = await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('shell')
    // The status watcher sees tmux announce the window and re-lists.
    const terminals = async (): Promise<WorkspaceTerminalEntry[] | undefined> =>
      (await listWorkspaces()).find((w) => w.workspaceId === workspaceId)?.terminals
    await vi.waitFor(async () => expect(await terminals()).toContainEqual(shell), { timeout: 10_000 })

    const kill = await fetch(`${origin()}/api/workspace/${workspaceId}/terminals/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: shell.target }),
    })
    expect(kill.status).toBe(204)
    await vi.waitFor(async () => expect(await terminals()).not.toContainEqual(shell), { timeout: 10_000 })
  })

  it('serves a webapp terminal from its pane: snapshot, raw output, input, paste and resize', async () => {
    // A pane that floods numbered lines, then echoes its input visibly.
    const window = (await tmux(workspaceId, 'new-window', '-d', '-P', '-F', '#{window_id}', '-t', 'yaac',
      '-n', 'mirror', "sh -c 'seq 1 100000; stty raw -echo; exec cat -v'")).trim()
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(server.lock.port)}/api/pty/attach?id=${workspaceId}&target=window:${window}&cols=100&rows=30`)
    const frames: Array<string | Buffer> = []
    ws.on('message', (data: Buffer, isBinary) => frames.push(isBinary ? data : data.toString('utf8')))
    try {
      const bytes = (): string => frames.filter((f): f is Buffer => typeof f !== 'string')
        .map((f) => f.toString('latin1')).join('')
      // Attached mid-flood: wait for the end of it.
      await vi.waitFor(() => expect(bytes()).toContain('100000'), { timeout: 30_000, interval: 200 })

      // The pane's size, then a snapshot that resets the client.
      expect(JSON.parse(frames[0] as string)).toEqual({ type: 'size', cols: 100, rows: 30 })
      expect((frames[1] as Buffer).subarray(0, 2).toString('latin1')).toBe('\x1bc')
      // The snapshot and the output after it hold every line exactly once,
      // in order: nothing the capture holds is sent again and nothing after
      // it is lost.
      const numbers = bytes()
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[c=]/g, '')
        .match(/\d+/g)?.map(Number) ?? []
      expect(numbers.at(-1)).toBe(100000)
      const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1)
      expect(gaps).toEqual([])
      expect(numbers.length).toBeGreaterThan(4000)

      // Keystrokes and a bracketed paste reach the pane through tmux; `cat`
      // never asked for bracketed paste, so tmux delivers it bare.
      ws.send(Buffer.from('ab'))
      ws.send(Buffer.from('\x1b[200~x$y\x1b[201~'))
      await vi.waitFor(async () => {
        // -J rejoins a wrapped line: `stty raw` can take effect before all of
        // `seq`'s output has gone through the tty, leaving the cursor anywhere.
        expect(await tmux(workspaceId, 'capture-pane', '-p', '-J', '-t', window)).toContain('abx$y')
        // And its echo comes back.
        expect(bytes()).toContain('abx$y')
      }, { timeout: 10_000, interval: 200 })

      // A resize sizes the window, and the new size comes back as a frame.
      ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }))
      await vi.waitFor(() => expect(frames.filter((f) => typeof f === 'string').map((f) => JSON.parse(f) as unknown))
        .toContainEqual({ type: 'size', cols: 90, rows: 25 }), { timeout: 10_000, interval: 200 })
      expect((await tmux(workspaceId, 'display', '-p', '-t', window, '#{window_width}x#{window_height}')).trim())
        .toBe('90x25')
    } finally {
      ws.close()
      await tmux(workspaceId, 'kill-window', '-t', window)
    }
  }, 60_000)

  // The CLI resolves a prefix to the exact id the terminal socket needs.
  it('attaches and opens a shell by a unique id prefix', async () => {
    const prefix = workspaceId.slice(0, 8)
    // Type only once the far end draws, or early bytes can be flushed. The
    // first Enter answers zsh's new-user menu (a fresh HOME shows it).
    const shell = await runYaac(serverEnv, 'workspace', 'shell', prefix, {
      stdinOnPrompt: [
        { when: /Type one of the keys|[%$#] /, send: '\n' },
        { when: /[%$#] /, send: 'echo "prefix-$((6*7))"; exit\n' },
      ],
    })
    expect(shell.exitCode, shell.stderr).toBe(0)
    expect(shell.stdout).toContain('prefix-42')

    // `C-b d` detaches, sent once tmux is drawing.
    const attach = await runYaac(serverEnv, 'workspace', 'attach', prefix, {
      stdinOnPrompt: [{ when: /\x1b\[/, send: '\x02d' }],
    })
    expect(attach.exitCode, attach.stderr).toBe(0)
    expect(attach.stderr).not.toMatch(/not found|error/i)
  }, 60_000)

  it.skipIf(!CAN_RUN_PORTS)('tunnels a connection onto a port the workspace is listening on', async () => {
    // A loopback dev server under the workspace's tmux server (the process
    // tree the port sweep walks), reached through `/api/forward/attach` as a
    // remote client would.
    const devPort = await freeLocalPort()
    const script = path.join(testEnv.scratchDir, 'dev-server.cjs')
    await fs.writeFile(script, `
      require('http').createServer((req, res) => res.end('hello from the workspace'))
        .listen(${String(devPort)}, '127.0.0.1')
    `)
    await tmux(workspaceId, 'new-window', '-d', '-t', 'yaac', '-n', 'dev',
      `'${process.execPath}' '${script}'`)
    // Detection is a poll.
    await vi.waitFor(async () => {
      const me = (await listWorkspaces()).find((w) => w.workspaceId === workspaceId)
      expect(me?.forwardedPorts).toEqual([{ containerPort: devPort, hostPort: devPort }])
    }, { timeout: 20_000, interval: 500 })

    // Against a local server the CLI refuses without `--bind` (see the last
    // case in the file), since the same host port would clash with the dev
    // server. Use a different host port.
    const hostPort = await freeLocalPort()
    const forwarder = startForwardCli(
      workspaceId, '--bind', '127.0.0.1', '--port', `${String(devPort)}:${String(hostPort)}`,
    )
    try {
      await forwarder.ready()
      const res = await fetch(`http://127.0.0.1:${String(hostPort)}/`)
      expect(await res.text()).toBe('hello from the workspace')
    } finally {
      await forwarder.stop()
    }
    // Without --port the ports come from the server's `/events` snapshots,
    // bound on another loopback address so they miss the dev server's.
    const offered = startForwardCli(workspaceId, '--bind', '127.0.0.2')
    try {
      await offered.ready()
      const res = await fetch(`http://127.0.0.2:${String(devPort)}/`)
      expect(await res.text()).toBe('hello from the workspace')
    } finally {
      await offered.stop()
      await tmux(workspaceId, 'kill-window', '-t', 'yaac:dev')
    }
    // A port the workspace is not listening on is refused, not relayed to
    // whatever else on this host holds it.
    const stray = startForwardCli(
      workspaceId, '--bind', '127.0.0.1', '--port', `${String(server.lock.port)}:${String(hostPort)}`,
    )
    try {
      await stray.ready()
      await expect(fetch(`http://127.0.0.1:${String(hostPort)}/health`)).rejects.toThrow()
      expect(stray.output()).toMatch(/dial failed/)
    } finally {
      await stray.stop()
    }
  }, 60_000)

  it('records a conversation started by hand in a new terminal, through the registered hook', async () => {
    // Each link fails silently: the command registered in settings.json,
    // the script on the workspace's PATH, the pane option it sets, and the
    // watcher on a pane that is not an agent window. The command must not
    // name an in-image path.
    const project = path.join(testEnv.dataDir, 'global', 'projects', SLUG)
    const commandsIn = async (file: string, event: string): Promise<string[]> => {
      const { hooks } = JSON.parse(await fs.readFile(file, 'utf8')) as
        { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }
      return hooks?.[event]?.flatMap((m) => m.hooks?.map((h) => h.command ?? '') ?? []) ?? []
    }
    const command = (await commandsIn(path.join(project, 'claude', 'settings.json'), 'SessionStart'))
      .find((c) => c.includes('yaac-agent-links'))
    expect(command).toBe('yaac-agent-links "$HOME/.claude" claude')
    // codex runs the same script from its own home.
    expect(await commandsIn(path.join(project, 'codex', 'hooks.json'), 'SessionStart'))
      .toEqual(['yaac-agent-links "$CODEX_HOME" codex'])

    const home = path.join(project, 'sessions', workspaceId, 'containerless', 'home')
    const binDir = path.join(home, '.local', 'bin')
    await expect(fs.access(path.join(binDir, 'yaac-agent-links'), fs.constants.X_OK))
      .resolves.toBeUndefined()

    // A new terminal (as the webapp's New Shell) and a transcript in the
    // tool home.
    const pane = (await tmux(workspaceId, 'new-window', '-d', '-n', 'shell-e2e', '-t', 'yaac', '-P', '-F', '#{pane_id}')).trim()
    await fs.mkdir(path.join(project, 'claude', 'projects', '-e2e'), { recursive: true })
    await fs.writeFile(path.join(project, 'claude', 'projects', '-e2e', 'e2e-conv.jsonl'), `${JSON.stringify({
      type: 'user', message: { role: 'user', content: 'asked from a shell' },
    })}\n`)

    // Run the registered command as claude in that pane would: `sh -c` with
    // the workspace's PATH, HOME and the pane's tmux variables.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh', ['-c', command ?? ''],
        {
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            TMUX: `${sockFor(workspaceId)},0,0`,
            TMUX_PANE: pane,
          },
        },
        (err) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()),
      )
      child.stdin?.end(JSON.stringify({
        session_id: 'e2e-conv',
        transcript_path: path.join(home, '.claude', 'projects', '-e2e', 'e2e-conv.jsonl'),
      }))
    })

    const conv = async () => (await listWorkspaces())
      .find((w) => w.workspaceId === workspaceId)?.agentSessions.find((s) => s.agentSessionId === 'e2e-conv')
    await vi.waitFor(async () => {
      expect(await conv()).toMatchObject({ tool: 'claude', active: true, prompt: 'asked from a shell' })
    }, { timeout: 30_000, interval: 250 })

    // Closing the terminal keeps the record but marks it inactive.
    await tmux(workspaceId, 'kill-pane', '-t', pane)
    await vi.waitFor(async () => {
      expect(await conv()).toMatchObject({ active: false })
    }, { timeout: 30_000, interval: 250 })
  })

  /**
   * The environment of a live pane, read from `/proc`. `show-environment`
   * shows what future panes get rather than what the launch set, and
   * running `printenv` in a new window would change the shared fixture.
   */
  async function workspaceEnv(id: string): Promise<Record<string, string>> {
    const pid = (await tmux(id, 'display-message', '-p', '-t', 'yaac', '#{pane_pid}')).trim()
    const raw = await fs.readFile(`/proc/${pid}/environ`, 'utf8')
    const env: Record<string, string> = {}
    for (const entry of raw.split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return env
  }

  /** The workspace's own yaac-mama credentials, memoized per file. */
  let mamaEnv: Record<string, string> | undefined
  const mamaCreds = async (): Promise<Record<string, string>> =>
    (mamaEnv ??= await workspaceEnv(workspaceId))

  /**
   * Run `yaac-mama` as the workspace would. With no proxy, it posts directly
   * to the server using the URL and bearer token from the workspace's
   * environment.
   */
  async function runMama(...args: string[]): Promise<{ code: number; out: string }> {
    const creds = await mamaCreds()
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `YAAC_MAMA_URL='${creds.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${creds.YAAC_MAMA_TOKEN}' `
      + `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted} 2>&1; echo "EXIT:$?"`,
    ])
    const m = /EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker:\n${stdout}`)
    return { code: Number(m[1]), out: stdout.slice(0, m.index) }
  }

  it('hands the workspace a yaac-mama credential and server address', async () => {
    const creds = await mamaCreds()
    expect(creds.YAAC_MAMA_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(creds.YAAC_MAMA_TOKEN).toBeTruthy()
    // The token is never written to the marker a restarted server rebuilds
    // the environment from.
    const marker = await fs.readFile(path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'sessions', workspaceId,
      'containerless', 'workspace.json',
    ), 'utf8')
    expect(marker).toContain(creds.YAAC_MAMA_URL)
    expect(marker).not.toContain(creds.YAAC_MAMA_TOKEN)
  })

  it('resolves its tool homes from the project, not the server user', async () => {
    // Unit tests check the env the driver computes; this checks what a pane
    // actually gets, with bogus values in the server's env (`beforeAll`).
    const env = await workspaceEnv(workspaceId)

    // Overrides with no replacement are removed, so tools fall back to the
    // private HOME. So are the variables of a claude session that started
    // the server.
    for (const key of [
      'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
      'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'GIT_EDITOR',
    ]) {
      expect(env[key], `${key} reached the workspace`).toBeUndefined()
    }
    // Replaced ones point at the project's directories, not per-workspace
    // paths (claude keys its macOS Keychain item on this string).
    const projectDir = path.join(testEnv.dataDir, 'global', 'projects', SLUG)
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(projectDir, 'claude'))
    expect(env.CODEX_HOME).toBe(path.join(projectDir, 'codex'))
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(projectDir, 'pi', 'agent'))
    // Per-workspace ones name the history directory itself, not a link.
    expect(env.PI_CODING_AGENT_SESSION_DIR)
      .toBe(path.join(projectDir, 'history', workspaceId, 'pi'))
    expect(env.CODEX_SQLITE_HOME)
      .toBe(path.join(projectDir, 'history', workspaceId, 'codex-sqlite'))
    // pnpm uses one store per project, not one per private HOME. It lives
    // in `node-local/`, keyed by project id
    // (docs/containerless-driver.md, "Storage"). pnpm itself is asked, since
    // a misnamed variable would fail silently.
    const projectsRoot = path.join(testEnv.dataDir, 'node-local', 'projects')
    const store = env.pnpm_config_store_dir ?? ''
    const projectId = path.relative(projectsRoot, store).split(path.sep)[0]
    expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const nodeLocalProject = path.join(projectsRoot, projectId)
    expect(store).toBe(path.join(nodeLocalProject, '.cached-packages', 'pnpm-store'))
    expect(env.npm_config_store_dir).toBe(store)
    // Nothing else is node-local here; opencode opens its global data
    // directly.
    expect((await fs.readdir(nodeLocalProject)).sort()).toEqual(['.cached-packages'])
    expect(await fs.realpath(path.join(env.HOME ?? '', '.local', 'share', 'opencode')))
      .toBe(await fs.realpath(path.join(projectDir, 'opencode-data', workspaceId)))
    const { stdout: storePath } = await execFileAsync('pnpm', ['store', 'path'], {
      env, cwd: path.join(projectDir, 'workspaces', workspaceId),
    })
    expect(storePath.trim().split('\n').pop()?.startsWith(store), storePath).toBe(true)

    // claude reads `$CLAUDE_CONFIG_DIR/.claude.json`, so the onboarding seed
    // must be there or every launch shows the wizard and trust dialog.
    const seeded = JSON.parse(await fs.readFile(
      path.join(env.CLAUDE_CONFIG_DIR ?? '', '.claude.json'), 'utf8',
    )) as { hasCompletedOnboarding?: boolean; projects?: Record<string, unknown> }
    expect(seeded.hasCompletedOnboarding).toBe(true)
    expect(seeded.projects?.[path.join(projectDir, 'workspaces', workspaceId)])
      .toEqual({ hasTrustDialogAccepted: true })
    // HOME is the workspace's own.
    expect(env.HOME).toContain(workspaceId)
    expect(env.HOME).not.toBe(process.env.HOME)
  })

  it('lists this project’s workspaces from inside the workspace', async () => {
    const { code, out } = await runMama('list')
    expect(code).toBe(0)
    expect(out).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
    // The token alone identifies the caller.
    expect(out).toContain(`${workspaceId.slice(0, 8)} (you)`)
  })

  it('makes a group and files itself into it, without a proxy anywhere', async () => {
    const made = await runMama('group', 'create', 'nightly')
    expect(made.code).toBe(0)

    const moved = await runMama('group', 'move', workspaceId.slice(0, 8), 'nightly')
    expect(moved.code).toBe(0)

    // Visible through the ordinary API.
    const res = await fetch(`${origin()}/api/workspace/group/list?project=${SLUG}`)
    const { groups } = await res.json() as { groups: Array<{ groupId: string; name: string }> }
    expect(groups.map((g) => g.name)).toContain('nightly')

    const listed = await runMama('list')
    expect(listed.out).toMatch(new RegExp(`${workspaceId.slice(0, 8)}[^\\n]*nightly`))
  })

  it('renames itself, which the server records against the caller\u2019s own id', async () => {
    // No id needed: the token identifies the caller.
    const renamed = await runMama('rename', 'wiring up the mama channel')
    expect(renamed.code).toBe(0)
    expect(renamed.out).toContain('wiring up the mama channel')

    const res = await fetch(`${origin()}/api/workspace/list?project=${SLUG}`)
    const body = await res.json() as { workspaces: Array<{ workspaceId: string; title?: string }> }
    const mine = body.workspaces.find((w) => w.workspaceId === workspaceId)
    expect(mine?.title).toBe('wiring up the mama channel')
  })

  it('spawns a sibling with the create form\u2019s options, never above its own posture', async () => {
    // The caller has the containerless default, which caps its siblings.
    const above = await runMama('create', '--permission-mode', 'bypass', 'x')
    expect(above.code).toBe(1)
    expect(above.out).toContain("more permissive than this workspace's own ('accept-edits')")

    const { stdout: branch } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const made = await runMama(
      'create', '--permission-mode', 'plan', '--ui-mode', 'tui', '--branch', branch.trim(), 'plan the work',
    )
    expect(made.code).toBe(0)
    const sibling = made.out.trim()
    try {
      // The id comes back before launch; wait for the launch command.
      await vi.waitFor(async () => {
        const cmd = await tmux(sibling, 'display', '-p', '-t', 'yaac:claude', '#{pane_start_command}')
        expect(cmd).toContain('--permission-mode plan')
      }, { timeout: 60_000, interval: 500 })
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', sibling)
    }
  }, 120_000)

  it('attributes a request to the token\u2019s OWN workspace, not the one asking', async () => {
    // Requests never name the caller, so the token alone must decide it:
    // another workspace's token retitles that workspace, not this one.
    const otherId = await createWorkspace()
    try {
      const theirs = await workspaceEnv(otherId)
      expect(theirs.YAAC_MAMA_TOKEN).not.toBe((await mamaCreds()).YAAC_MAMA_TOKEN)

      const res = await fetch(`${origin()}/api/workspace/mama`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${theirs.YAAC_MAMA_TOKEN}`,
        },
        body: JSON.stringify({ command: 'rename', args: {}, body: 'named by its own token' }),
      })
      expect(res.status).toBe(200)

      const listed = await fetch(`${origin()}/api/workspace/list?project=${SLUG}`)
      const body = await listed.json() as {
        workspaces: Array<{ workspaceId: string; title?: string }>
      }
      const byId = new Map(body.workspaces.map((w) => [w.workspaceId, w.title]))
      expect(byId.get(otherId)).toBe('named by its own token')
      expect(byId.get(workspaceId)).not.toBe('named by its own token')
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', otherId)
    }
  }, 120_000)

  it('refuses a command outside the allowlist, and an unknown token', async () => {
    const denied = await runMama('delete', workspaceId)
    expect(denied.code).toBe(2)
    expect(denied.out).toContain('unknown command')

    // An empty argument (e.g. `stop "$id"` with $id unset) is a usage error,
    // not a self-stop.
    const empty = await runMama('stop', '')
    expect(empty.code).toBe(2)
    expect(empty.out).toContain('omit the workspace to stop yourself')

    // The server itself refuses the command and an unknown token.
    const post = async (token: string, command: string): Promise<number> => {
      const res = await fetch(`${origin()}/api/workspace/mama`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command, args: {}, body: 'x' }),
      })
      return res.status
    }
    const token = (await mamaCreds()).YAAC_MAMA_TOKEN
    expect(await post(token, 'delete')).toBe(422)
    expect(await post('not-a-real-token', 'list')).toBe(401)
  })

  it('stops a workspace it names, stops ITSELF when it names none, and the stopped one stays fetchable', async () => {
    // Its own subject: the self-stop takes down the tmux server the command
    // runs in.
    const doomed = await createWorkspace()
    const theirs = await workspaceEnv(doomed)
    const asDoomed = async (...args: string[]): Promise<{ code: number; out: string }> => {
      const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
      const { stdout } = await execFileAsync('sh', ['-c',
        `YAAC_MAMA_URL='${theirs.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${theirs.YAAC_MAMA_TOKEN}' `
        + `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted} 2>&1; echo "EXIT:$?"`,
      ])
      const m = /EXIT:(\d+)\s*$/.exec(stdout)
      if (!m) throw new Error(`no exit marker:\n${stdout}`)
      return { code: Number(m[1]), out: stdout.slice(0, m.index) }
    }

    const missing = await asDoomed('stop', 'no-such-workspace')
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('no workspace')

    // With no workspace named it stops itself. The reply may not survive,
    // so assert that the tmux server goes away.
    await asDoomed('stop').catch(() => undefined)
    let gone = false
    for (let i = 0; i < 60 && !gone; i++) {
      gone = await tmux(doomed, 'has-session', '-t', 'yaac').then(() => false, () => true)
      if (!gone) await new Promise((r) => setTimeout(r, 1_000))
    }
    expect(gone).toBe(true)
    // A stop keeps the checkout.
    const doomedCheckout = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', doomed)
    await expect(fs.stat(doomedCheckout)).resolves.toBeDefined()

    // ...and its committed work stays readable: this workspace fetches it
    // into its own checkout, standing in that checkout as an agent does.
    await execFileAsync('git', ['-C', doomedCheckout, '-c', 'user.email=t@t', '-c', 'user.name=T',
      'commit', '--allow-empty', '-qm', 'left behind'])
    const mine = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId)
    const creds = await mamaCreds()
    const { stdout } = await execFileAsync(path.join(process.cwd(), 'workspace-bin', 'yaac-mama'),
      ['fetch', doomed.slice(0, 8)],
      { cwd: mine, env: { ...process.env, YAAC_MAMA_URL: creds.YAAC_MAMA_URL, YAAC_MAMA_TOKEN: creds.YAAC_MAMA_TOKEN } })
    const short = doomed.slice(0, 8)
    expect(stdout).toContain(`yaac/peers/${short}/HEAD`)
    const { stdout: subject } = await execFileAsync('git', ['-C', mine, 'log', '-1', '--format=%s', `yaac/peers/${short}/HEAD`])
    expect(subject.trim()).toBe('left behind')
  }, 180_000)

  it('offers yaac\'s builtin skills where the agent\'s own HOME looks for them', async () => {
    // A pod mounts the skills; here they are symlinked into the project's
    // shared tool roots. Read them the way the agent does, through the
    // workspace HOME.
    const entries = await fs.readdir(builtinSkillsDir(), { withFileTypes: true })
    const names: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const hasSkill = await fs.access(path.join(builtinSkillsDir(), e.name, 'SKILL.md'))
        .then(() => true, () => false)
      if (hasSkill) names.push(e.name)
    }
    expect(names.length).toBeGreaterThan(0)

    const home = workspaceHome(SLUG, workspaceId)
    for (const name of names) {
      const viaHome = path.join(home, '.claude', 'skills', name, 'SKILL.md')
      expect(await fs.readFile(viaHome, 'utf8')).toContain('---')
    }
    // Linked, not copied, so an upgrade reaches every workspace. The target
    // is the built server's install, so only its shape is checked.
    for (const root of sharedSkillRoots(SLUG)) {
      const target = await fs.readlink(path.join(root, names[0]))
      expect(target.endsWith(path.join('builtin-skills', names[0]))).toBe(true)
      await expect(fs.access(path.join(target, 'SKILL.md'))).resolves.toBeUndefined()
    }
  })

  it('signs in with a real bundle, then lets a running workspace\'s refresh win', async () => {
    // The credential cycle with no proxy, in the order it happens.
    const hostCreds = path.join(testEnv.dataDir, 'server-local', '.credentials', 'claude.json')
    const projectCreds = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'claude', '.credentials.json')
    const readBundle = async (p: string): Promise<Record<string, unknown>> => {
      const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as { claudeAiOauth: Record<string, unknown> }
      return parsed.claudeAiOauth
    }

    // 1. A sign-in reaches the project home as the real bundle, not a
    //    placeholder (there is no proxy to swap it).
    const signedIn = {
      accessToken: 'sk-ant-oat01-signed-in',
      refreshToken: 'sk-ant-ort01-signed-in',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    }
    const { exitCode: authExit } = await runYaac(
      { ...serverEnv, YAAC_E2E_CLAUDE_LOGIN: JSON.stringify(signedIn) },
      'auth', 'update', { stdin: '2\n' },
    )
    expect(authExit).toBe(0)
    expect(await readBundle(projectCreds)).toEqual(signedIn)

    // 2. The agent refreshes its own token in the project home; the host
    //    store still has the old one.
    const refreshed = {
      ...signedIn,
      accessToken: 'sk-ant-oat01-refreshed',
      refreshToken: 'sk-ant-ort01-refreshed',
      expiresAt: signedIn.expiresAt + 3_600_000,
    }
    await fs.writeFile(projectCreds, JSON.stringify({ claudeAiOauth: refreshed }, null, 2))

    // 3. Another create must not overwrite it with the stale host copy,
    //    which would log the running agent out.
    const second = await createWorkspace()
    try {
      expect(await readBundle(projectCreds)).toMatchObject({
        accessToken: 'sk-ant-oat01-refreshed',
        refreshToken: 'sk-ant-ort01-refreshed',
      })
      // The host store picks up the refreshed token.
      expect(await readBundle(hostCreds)).toMatchObject({
        accessToken: 'sk-ant-oat01-refreshed',
        refreshToken: 'sk-ant-ort01-refreshed',
      })
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', second)
    }
  }, 120_000)

  it('creates a workspace without running what was planted in the main clone or a sibling', async () => {
    // A checkout gets a git dir and config of its own (docs/server-git.md).
    // Plant a filter driver and hooks (each leaves a marker) in the main
    // clone and a sibling; the new checkout must run none of them.
    const gitDir = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'repo', '.git')
    const markers = path.join(testEnv.scratchDir, 'planted-markers')
    const hooks = path.join(testEnv.scratchDir, 'planted-hooks')
    const evil = path.join(testEnv.scratchDir, 'planted.sh')
    await fs.mkdir(markers, { recursive: true })
    await fs.mkdir(hooks, { recursive: true })
    await fs.writeFile(evil, `#!/bin/sh\ntouch "${markers}/$1"\ncat\n`)
    await fs.chmod(evil, 0o755)
    for (const hook of ['post-checkout', 'reference-transaction']) {
      await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\n"${evil}" ${hook} </dev/null\n`)
      await fs.chmod(path.join(hooks, hook), 0o755)
    }
    const configPath = path.join(gitDir, 'config')
    const attributesPath = path.join(gitDir, 'info', 'attributes')
    const configBefore = await fs.readFile(configPath, 'utf8')
    const sibling = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId, '.git')
    const siblingConfigBefore = await fs.readFile(path.join(sibling, 'config'), 'utf8')
    for (const [key, value] of [
      ['filter.planted.smudge', `"${evil}" smudge`],
      ['filter.planted.clean', `"${evil}" clean`],
      ['core.hooksPath', hooks],
    ]) {
      await execFileAsync('git', ['--git-dir', gitDir, 'config', key, value])
      await execFileAsync('git', ['--git-dir', sibling, 'config', key, value])
    }
    await fs.mkdir(path.dirname(attributesPath), { recursive: true })
    await fs.writeFile(attributesPath, '* filter=planted\n')

    let id: string | undefined
    try {
      id = await createWorkspace()
      const checkout = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', id)
      expect(await fs.readFile(path.join(checkout, 'README.md'), 'utf8')).toBe('# Test repo\n')
      expect(await fs.readdir(markers)).toEqual([])
      await expect(execFileAsync('git', ['-C', checkout, 'config', 'core.hooksPath'])).rejects.toThrow()
    } finally {
      // Remove the planted config before later cases.
      await fs.writeFile(configPath, configBefore)
      await fs.writeFile(path.join(sibling, 'config'), siblingConfigBefore)
      await fs.rm(attributesPath, { force: true })
      if (id !== undefined) await runYaac(serverEnv, 'workspace', 'stop', id)
    }
  }, 120_000)

  // The webapp's create dialog: the title and group are recorded before
  // the prompt, so the auto-title sweep never replaces the title.
  it('creates a workspace titled and filed as the create dialog asks', async () => {
    const res = await fetch(`${origin()}/api/workspace/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: SLUG, tool: 'claude', mode: 'tui', prompt: 'a founding ask', title: 'Dialog title',
        group: 'dialog-group',
      }),
    })
    expect(res.status).toBe(200)
    const { workspaceId: id } = await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})
    try {
      const groups = await (await fetch(`${origin()}/api/workspace/group/list?project=${SLUG}`)).json() as {
        groups: Array<{ groupId: string; name: string }>
      }
      const group = groups.groups.find((g) => g.name === 'dialog-group')
      expect((await listWorkspaces()).find((w) => w.workspaceId === id))
        .toMatchObject({ title: 'Dialog title', groupId: group?.groupId })
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', id)
    }
  }, 120_000)

  /**
   * The permission mode a TUI agent reports: claude's prompt hook sets a
   * pane option, which the server records. Checked through the
   * `yaac-mama create` ceiling here and the restart below. Runs after the
   * mama cases, since it changes the shared workspace's posture.
   */
  it('follows a mode the agent reports, down and back up past the one it was created in', async () => {
    const settings = JSON.parse(await fs.readFile(
      path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'claude', 'settings.json'), 'utf8',
    )) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }
    const command = settings.hooks?.UserPromptSubmit
      ?.flatMap((m) => m.hooks?.map((h) => h.command) ?? [])
      .find((c) => c?.includes('yaac-agent-report'))
    expect(command).toBeDefined()

    // claude runs with $TMUX hidden, so the launch passes it as $YAAC_TMUX.
    // Read it from the running agent's environment.
    const pane = (await tmux(workspaceId, 'display-message', '-p', '-t', 'yaac:claude', '#{pane_id}')).trim()
    const pid = (await tmux(workspaceId, 'display-message', '-p', '-t', 'yaac:claude', '#{pane_pid}')).trim()
    const agentEnv = async (p: string): Promise<string | undefined> => {
      const env = (await fs.readFile(`/proc/${p}/environ`, 'utf8').catch(() => ''))
        .split('\0').find((e) => e.startsWith('YAAC_TMUX='))
      if (env !== undefined) return env.slice('YAAC_TMUX='.length)
      const kids = (await fs.readFile(`/proc/${p}/task/${p}/children`, 'utf8').catch(() => ''))
        .trim().split(/\s+/).filter(Boolean)
      for (const kid of kids) {
        const found = await agentEnv(kid)
        if (found !== undefined) return found
      }
      return undefined
    }
    const yaacTmux = await agentEnv(pid)
    expect(yaacTmux?.split(',')[0]).toBe(sockFor(workspaceId))

    const home = path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'sessions', workspaceId, 'containerless', 'home',
    )
    const binDir = path.join(home, '.local', 'bin')
    // Run the registered command through `sh -c`, as claude does.
    const prompt = (permissionMode: string): Promise<string> => new Promise((resolve, reject) => {
      const child = execFile('sh', ['-c', command ?? ''], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          TMUX: '',
          TMUX_PANE: pane,
          YAAC_TMUX: yaacTmux ?? '',
        },
      }, (err, out) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve(out)))
      child.stdin?.end(JSON.stringify({
        session_id: workspaceId, hook_event_name: 'UserPromptSubmit', prompt: 'go', permission_mode: permissionMode,
      }))
    })
    const ceiling = async (): Promise<string> => (await runMama('create', '--permission-mode', 'bypass', 'x')).out

    // Switch to plan, reported with the next prompt. The hook must print
    // nothing: UserPromptSubmit output goes to the model.
    expect(await prompt('plan')).toBe('')
    expect((await tmux(workspaceId, 'show-options', '-p', '-t', pane, '-v', '@yaac-permission-mode')).trim())
      .toBe('plan')
    await vi.waitFor(async () => {
      expect(await ceiling()).toContain("more permissive than this workspace's own ('plan')")
    }, { timeout: 30_000, interval: 500 })

    // A move above the created posture is recorded too, and left for the
    // restart case.
    await prompt('auto')
    await vi.waitFor(async () => {
      expect(await ceiling()).toContain("more permissive than this workspace's own ('auto')")
    }, { timeout: 30_000, interval: 500 })
  }, 120_000)

  // Destroys its subject — keep last.
  it('stops the workspace by taking its tmux server down', async () => {
    // Here ephemeral paths live in the checkout, and stop removes them
    // (checked in the next case).
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId)
    await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })
    const { exitCode } = await runYaac(serverEnv, 'workspace', 'stop', workspaceId)
    expect(exitCode).toBe(0)
    // Polled: teardown is detached, so the kill can land after `stop`
    // returns.
    await vi.waitFor(
      async () => { await expect(tmux(workspaceId, 'has-session', '-t', 'yaac')).rejects.toThrow() },
      { timeout: 20_000, interval: 250 },
    )
  }, 60_000)

  it('leaves the checkout behind, and stays stopped rather than flickering back', async () => {
    const dir = path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId,
    )
    await expect(fs.stat(dir)).resolves.toBeDefined()
    // Without its ephemeral paths, which would otherwise be a full copy of
    // every dependency. Polled, since teardown is detached.
    await vi.waitFor(
      async () => { await expect(fs.stat(path.join(dir, 'node_modules'))).rejects.toThrow() },
      { timeout: 20_000, interval: 250 },
    )

    // A workspace the driver failed to forget would reappear as
    // "stopping…" on each stale-reaper pass.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1_000))
      expect((await listWorkspaces()).map((w) => w.workspaceId)).not.toContain(workspaceId)
    }
  }, 60_000)

  it('still reads the checkout\'s files once the workspace is stopped, but lists them only while it runs', async () => {
    const res = await fetch(`${origin()}/api/workspace/${workspaceId}/file?path=notes/todo.md`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ path: 'notes/todo.md', content: 'mine\n' })
    // Listing runs git inside the workspace, so it needs it running.
    expect((await fetch(`${origin()}/api/workspace/${workspaceId}/files`)).status).toBe(409)
  })

  // The launch updates the checkout's `origin/*` from the main clone.
  it('restarts the stopped workspace back onto a live tmux server', async () => {
    const repoGit = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'repo', '.git')
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', workspaceId)
    const base = (await execFileAsync('git', ['--git-dir', repoGit, 'symbolic-ref', 'refs/remotes/origin/HEAD'])).stdout.trim()
    const upstream = (await execFileAsync('git', [
      '--git-dir', repoGit, 'commit-tree', '-p', base, '-m', 'upstream', `${base}^{tree}`,
    ], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })).stdout.trim()
    await execFileAsync('git', ['--git-dir', repoGit, 'update-ref', base, upstream])
    // History a pod leaves in the workspace's `history/`, which this host
    // reaches through links (docs/workspace-storage.md, "Agent history").
    const project = path.join(testEnv.dataDir, 'global', 'projects', SLUG)
    const history = path.join(project, 'history', workspaceId)
    const rollout = path.join('2026', '09', '29', 'rollout-2026-09-29T08-32-40-pod-thread.jsonl')
    for (const [file, body] of [
      [path.join(history, 'claude', '-workspace', 'pod-conv.jsonl'), '{"from":"the pod"}\n'],
      [path.join(history, 'claude-file-history', 'pod-conv', 'edit@v1'), 'before\n'],
      [path.join(history, 'codex', rollout), '{"type":"session_meta","payload":{"id":"pod-thread"}}\n'],
    ]) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, body)
    }

    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'workspace', 'restart', workspaceId,
    )
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    const windows = await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('claude')
    // Relaunched in the last reported posture (auto, from the case above).
    await vi.waitFor(async () => {
      expect(await tmux(workspaceId, 'display', '-p', '-t', 'yaac:claude', '#{pane_start_command}'))
        .toContain('--permission-mode auto')
    }, { timeout: 30_000, interval: 250 })

    expect((await fs.stat(path.join(checkout, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(checkout, '.git', 'objects', 'info', 'alternates'), 'utf8'))
      .toBe(`${path.join(repoGit, 'objects')}\n`)
    await expect(execFileAsync('git', ['-C', checkout, 'status', '--porcelain']))
      .resolves.toBeDefined()
    expect((await execFileAsync('git', ['-C', checkout, 'rev-parse', base])).stdout.trim())
      .toBe(upstream)
    const files = await (await fetch(`${origin()}/api/workspace/${workspaceId}/files`)).json() as { paths: string[] }
    expect(files.paths).toEqual(expect.arrayContaining(['README.md', 'notes/todo.md']))

    // The pod's conversations resume here: claude's project folder for this
    // checkout links to the history, and each file-history dir and rollout
    // is linked where its tool looks.
    const projects = path.join(project, 'claude', 'projects')
    const linked: string[] = []
    for (const name of await fs.readdir(projects)) {
      const real = await fs.realpath(path.join(projects, name)).catch(() => '')
      if (real === await fs.realpath(path.join(history, 'claude', '-workspace'))) linked.push(name)
    }
    expect(linked.length).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(projects, linked[0], 'pod-conv.jsonl'), 'utf8')).toBe('{"from":"the pod"}\n')
    expect(await fs.readFile(path.join(project, 'claude', 'file-history', 'pod-conv', 'edit@v1'), 'utf8')).toBe('before\n')
    expect((await fs.lstat(path.join(project, 'codex', 'sessions', rollout))).isSymbolicLink()).toBe(true)
    await runYaac(serverEnv, 'workspace', 'stop', workspaceId)
  }, 180_000)
  // codex conversations are known only through its hook: the title
  // session fires the same hook, a resume fires none until the next turn,
  // and an unprompted workspace has no conversation.
  it('keeps resuming a codex conversation across restarts, and starts one never prompted anew', async () => {
    const launches = async (id: string): Promise<string[]> => (await fs.readFile(
      path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'codex', `launches-${id}`), 'utf8',
    ).catch(() => '')).split('\n').filter(Boolean)
    const codexSessions = async (id: string) => (await listWorkspaces())
      .find((w) => w.workspaceId === id)?.agentSessions.filter((s) => s.tool === 'codex' && s.active) ?? []
    const restart = async (id: string): Promise<void> => {
      const { stdout, stderr, exitCode } = await runYaac(serverEnv, 'workspace', 'restart', id)
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    }

    const prompted = await createWorkspaceWith('codex', '--prompt', 'hello')
    // The first turn reports the conversation.
    let thread = ''
    await vi.waitFor(async () => {
      thread = (await codexSessions(prompted)).find((s) => s.agentSessionId.startsWith('thread-'))?.agentSessionId ?? ''
      expect(thread).not.toBe('')
    }, { timeout: 30_000, interval: 250 })

    // Restart twice with no turn between. A resume reports nothing, so the
    // launch must record the conversation itself for the second restart to
    // find it. The title session must not take its place.
    for (const n of [2, 3]) {
      await restart(prompted)
      await vi.waitFor(async () => {
        expect((await launches(prompted))).toHaveLength(n)
        expect((await launches(prompted)).at(-1)).toMatch(new RegExp(` resume ${thread}$`))
        const active = await codexSessions(prompted)
        expect(active.map((s) => s.agentSessionId)).toEqual([thread])
        expect(active[0]?.status).toBeDefined()
      }, { timeout: 30_000, interval: 250 })
    }

    // An unprompted workspace has nothing to resume, and a bad
    // `resume` would kill the window.
    const unprompted = await createWorkspaceWith('codex')
    await restart(unprompted)
    await vi.waitFor(async () => {
      expect(await launches(unprompted)).toHaveLength(2)
    }, { timeout: 30_000, interval: 250 })
    expect((await launches(unprompted)).at(-1)).not.toContain('resume')
    expect(await tmux(unprompted, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')).toContain('codex')

    await runYaac(serverEnv, 'workspace', 'stop', prompted)
    await runYaac(serverEnv, 'workspace', 'stop', unprompted)
  }, 180_000)
})

/**
 * `--mode acp` on a host: acpd supervises the adapter as a host process,
 * reached over a UNIX socket. What can go wrong is host-specific (the
 * adapter's cwd, `socat`, the handshake), and shows up as a workspace that
 * dies right after create or a pane that stays empty. Missing adapters or
 * socat are unit-tested, since the server's PATH is fixed at spawn.
 */
describe.skipIf(!CAN_RUN_ACP)('containerless workspaces in acp mode', () => {
  /**
   * One case per tool: the binary acpd runs, the launch command, and the
   * posture sent over the protocol differ. The shared path (socket, record,
   * row) is checked for each.
   */
  const CASES: Array<{
    tool: AgentTool
    posture: string
    /** The mode id the adapter should be sent, if the posture is sent as one. */
    modeId?: string
    /** Fragments the tmux window's command must carry. */
    launch: string[]
    /** The model the row should show: the handshake's, unless changed after. */
    model: string | undefined
    /** Created with no `--mode`, so it is chat only by default. */
    bare?: true
  }> = [
    {
      // The adapter takes no flags, so the model goes in its environment.
      // It reports a picker alias, recorded as the matching catalog id.
      tool: 'claude',
      posture: 'accept-edits',
      modeId: 'acceptEdits',
      launch: [`ANTHROPIC_MODEL=${FALLBACK_MODELS.claude}`, '-- claude-agent-acp'],
      model: 'claude-opus-5-5',
    },
    {
      // codex's strictest posture, a real read-only sandbox in codex-acp.
      // It is a switch away from the adapter's `agent` default, where
      // failing would leave the conversation looser than asked.
      // (`accept-edits` → `workspace-write` is pinned in drivers.test.ts.)
      tool: 'codex',
      posture: 'read-only',
      modeId: 'read-only',
      launch: ['NO_BROWSER=1', 'CODEX_PATH=codex', '-- codex-acp'],
      model: 'e2e-model',
    },
    {
      // `plan` is the only opencode posture sent as a mode (in v2's
      // `mode` config option); the rest travel in the launch config.
      tool: 'opencode',
      posture: 'plan',
      modeId: 'plan',
      launch: ['OPENCODE_CONFIG_CONTENT=', '-- opencode acp'],
      // The model is sent after the handshake, so the row shows the
      // create's model, not the handshake's.
      model: defaultModelFor('opencode', undefined),
    },
    {
      // pi takes no model at launch; the provider default is sent as the
      // `model` config option after the handshake, and the row shows it.
      // Nothing in this file creates pi otherwise, so no mode is remembered
      // for it and a create naming none is chat.
      tool: 'pi',
      posture: 'bypass',
      launch: ['-- pi-acp'],
      model: piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel,
      bare: true,
    },
  ]

  it.each(CASES)('supervises $tool\'s adapter under acpd and handshakes a conversation',
    async ({ tool, posture, modeId, launch, model, bare }) => {
      const { workspaceId: id, stdout } = await createWorkspaceFrom(
        '--tool', tool, ...(bare ? [] : ['--mode', 'acp']), '--permission-mode', posture,
      )
      // The CLI cannot show a chat, so it points at the web app instead.
      expect(stdout).toContain(`Workspace ${id} is running in ACP mode — open it in the web app`)

      // No pod events exist here, so the create itself must register the
      // conversation. Checked right after create without polling: create
      // waits for the row, so the webapp can show the chat pane at once.
      const res = await fetch(`${origin()}/api/workspace/list`)
      const { workspaces } = await res.json() as {
        workspaces: Array<{ workspaceId: string; agentSessions: AgentSessionEntry[] }>
      }
      const row = workspaces.find((w) => w.workspaceId === id)
      expect(row?.agentSessions.map((s) => s.agentSessionId)).toContain(`e2e-acp-${tool}`)
      expect(row?.agentSessions[0]?.mode).toBe('acp')
      // From the record; most tools leave no transcript to read.
      expect(row?.agentSessions[0]?.model).toBe(model)

      // The record is renamed to the session id once `session/new` answers,
      // so its name shows the handshake completed.
      const record = path.join(
        testEnv.dataDir, 'global', 'projects', SLUG, 'acp', id, `e2e-acp-${tool}.jsonl`,
      )
      await vi.waitFor(async () => {
        expect(await fs.readFile(record, 'utf8')).toContain('initialize')
      }, { timeout: 30_000, interval: 250 })

      // acpd records both directions.
      const relayed = (await fs.readFile(record, 'utf8')).trim().split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as {
              method?: string
              params?: { modeId?: string }
              result?: { sessionId?: string; cwd?: string }
            }]
          } catch {
            return []
          }
        })

      // The adapter's own cwd must be the checkout; a nonexistent directory
      // (e.g. a container path) fails the spawn like a missing binary.
      const created = relayed.find((m) => m.result?.sessionId === `e2e-acp-${tool}`)
      // `process.cwd()` resolves symlinks, so compare resolved paths.
      expect(created?.result?.cwd).toBe(
        await fs.realpath(path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'workspaces', id)),
      )

      // The posture is sent over the protocol, only where the adapter
      // advertises a matching mode.
      const setMode = relayed.find((m) => m.method === 'session/set_mode')
      expect(setMode?.params?.modeId).toBe(modeId)
      // The row keeps the posture asked for; a refused switch would record
      // the adapter's looser default instead.
      const after = await (await fetch(`${origin()}/api/workspace/list`)).json() as {
        workspaces: Array<{ workspaceId: string; permissionMode?: string }>
      }
      expect(after.workspaces.find((w) => w.workspaceId === id)?.permissionMode).toBe(posture)

      // Check the launch command; a wrong variable would be silently ignored.
      const startCmd = await tmux(id, 'display', '-p', '-t', `yaac:${tool}`, '#{pane_start_command}')
      for (const fragment of launch) expect(startCmd).toContain(fragment)

      // A dead adapter would take the window down with it.
      const windows = await tmux(id, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
      expect(windows).toContain(tool)

      await runYaac(serverEnv, 'workspace', 'stop', id)
    }, 180_000)

  it('records a mode the agent moves itself to, and restarts the conversation in it', async () => {
    // The agent moves itself into plan mode mid-turn (as EnterPlanMode
    // does); a restart must relaunch in plan, not the created posture.
    const id = await createWorkspaceWith(
      'claude', '--mode', 'acp', '--permission-mode', 'accept-edits', '--prompt', ENTER_PLAN_MODE,
    )
    const record = path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'acp', id, 'e2e-acp-claude.jsonl',
    )
    const relayed = async (): Promise<Array<{
      id?: unknown; method?: string; params?: { modeId?: string }; result?: unknown
    }>> => (await fs.readFile(record, 'utf8').catch(() => '')).split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as { id?: unknown; method?: string; params?: { modeId?: string } }]
      } catch {
        return []
      }
    })
    const setModes = async (): Promise<Array<string | undefined>> =>
      (await relayed()).filter((m) => m.method === 'session/set_mode').map((m) => m.params?.modeId)

    // The turn is done once its reply is recorded.
    await vi.waitFor(async () => {
      const lines = await relayed()
      const prompt = lines.find((m) => m.method === 'session/prompt')
      expect(prompt).toBeDefined()
      expect(lines.some((m) => m.method === undefined && m.id === prompt?.id)).toBe(true)
    }, { timeout: 30_000, interval: 250 })
    expect(await setModes()).toEqual(['acceptEdits'])

    expect((await runYaac(serverEnv, 'workspace', 'stop', id)).exitCode).toBe(0)
    expect((await runYaac(serverEnv, 'workspace', 'restart', id)).exitCode).toBe(0)
    // acpd starts a new record, so the only set_mode is the restart's.
    await vi.waitFor(async () => {
      expect(await setModes()).toEqual(['plan'])
    }, { timeout: 30_000, interval: 250 })

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  // A move up (as a "yes, and bypass permissions" plan exit does) is
  // followed too.
  it('records a mode the agent moves itself up to, and restarts the conversation in it', async () => {
    const id = await createWorkspaceWith(
      'claude', '--mode', 'acp', '--permission-mode', 'plan', '--prompt', 'enter bypassPermissions mode',
    )
    const record = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'acp', id, 'e2e-acp-claude.jsonl')
    const relayed = async (): Promise<Array<{
      id?: unknown; method?: string; params?: { modeId?: string; id?: string }
    }>> => (await fs.readFile(record, 'utf8').catch(() => '')).split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as { id?: unknown; method?: string; params?: { modeId?: string; id?: string } }]
      } catch {
        return []
      }
    })
    const life = async (): Promise<string | undefined> =>
      (await relayed()).find((m) => m.method === '_acpd/life')?.params?.id
    await vi.waitFor(async () => {
      const lines = await relayed()
      const prompt = lines.find((m) => m.method === 'session/prompt')
      expect(prompt).toBeDefined()
      expect(lines.some((m) => m.method === undefined && m.id === prompt?.id)).toBe(true)
    }, { timeout: 30_000, interval: 250 })
    const before = await life()

    expect((await runYaac(serverEnv, 'workspace', 'stop', id)).exitCode).toBe(0)
    expect((await runYaac(serverEnv, 'workspace', 'restart', id)).exitCode).toBe(0)
    await vi.waitFor(async () => {
      expect(await life()).not.toBe(before)
      expect((await relayed()).filter((m) => m.method === 'session/set_mode').map((m) => m.params?.modeId))
        .toEqual(['bypassPermissions'])
    }, { timeout: 30_000, interval: 250 })

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  it('hands a pasted image to the agent: a file for the terminal, a block for the chat', async () => {
    const id = await createWorkspaceWith('claude', '--mode', 'acp', '--permission-mode', 'accept-edits')
    const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('e2e pixels')])

    // A terminal paste returns a host path, also linked into the agent's
    // HOME where a pod would mount it.
    const res = await fetch(`${origin()}/api/workspace/${id}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    })
    expect(res.status).toBe(200)
    const { path: pasted } = await res.json() as { path: string }
    expect(await fs.readFile(pasted)).toEqual(png)
    const home = path.join(
      testEnv.dataDir, 'global', 'projects', SLUG, 'sessions', id, 'containerless', 'home',
    )
    expect(await fs.readFile(path.join(home, '.yaac-attachments', path.basename(pasted)))).toEqual(png)

    // A chat message carries the image inline to the agent, and it shows in
    // the history a later attach receives.
    const attach = async (): Promise<{ ws: WebSocket; hello: { events: Array<{ type: string; content?: unknown[] }> } }> => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${String(server.lock.port)}/api/acp/attach?id=${id}&session=e2e-acp-claude`,
      )
      const hello = await new Promise<{ events: Array<{ type: string; content?: unknown[] }> }>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse((data as Buffer).toString('utf8')) as { type: string; events: Array<{ type: string }> }
          if (msg.type === 'hello') resolve(msg)
        })
        ws.once('close', () => reject(new Error('closed before hello')))
        ws.once('error', reject)
      })
      return { ws, hello }
    }
    const first = await vi.waitFor(attach, { timeout: 30_000, interval: 500 })
    const image = { type: 'image', mimeType: 'image/png', data: png.toString('base64') }
    first.ws.send(JSON.stringify({ type: 'prompt', text: 'what is this?', images: [image] }))
    const record = path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'acp', id, 'e2e-acp-claude.jsonl')
    await vi.waitFor(async () => {
      const prompt = (await fs.readFile(record, 'utf8')).split('\n')
        .map((l) => { try { return JSON.parse(l) as { method?: string; params?: { prompt?: unknown } } } catch { return {} } })
        .find((m) => m.method === 'session/prompt')
      expect(prompt?.params?.prompt).toEqual([{ type: 'text', text: 'what is this?' }, image])
    }, { timeout: 30_000, interval: 250 })
    first.ws.close()

    const second = await attach()
    second.ws.close()
    expect(second.hello.events.find((e) => e.type === 'user')?.content)
      .toEqual([{ type: 'text', text: 'what is this?' }, image])

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)

  it('lets a create go once its adapter has died, rather than holding for a handshake', async () => {
    // A dead adapter takes acpd and its window down; create must notice and
    // return rather than wait out the handshake timeout.
    const marker = path.join(path.dirname(managedBin('claude-agent-acp')), ACP_ADAPTER_DIES)
    await fs.writeFile(marker, '')
    try {
      const started = Date.now()
      const { exitCode, stdout, stderr } = await runYaac(
        serverEnv, 'workspace', 'create', SLUG, '--tool', 'claude', '--mode', 'acp',
      )
      expect(exitCode, `${stdout}${stderr}`).toBe(0)
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      await fs.rm(marker, { force: true })
    }
  }, 120_000)
})

// Replaces the shared server, so it runs after the cases above.
describe.skipIf(!CAN_RUN)('containerless recovery across a server restart', () => {
  it('re-adopts a workspace whose tmux server outlived the server that made it', async () => {
    const id = await createWorkspace()

    // A real restart on the same data dir, via the fixture so `server`
    // stays the process afterAll stops.
    await server.stop()
    server = await spawnYaacServer(serverEnv)

    // Restarting the server must not stop any agent.
    await expect(tmux(id, 'has-session', '-t', 'yaac')).resolves.toBeDefined()

    // The new server recovers it from the markers on disk. Polled, since
    // recovery runs after the server starts answering.
    await vi.waitFor(
      async () => expect((await listWorkspaces()).map((w) => w.workspaceId)).toContain(id),
      { timeout: 20_000, interval: 250 },
    )

    await runYaac(serverEnv, 'workspace', 'stop', id)
  }, 180_000)
})

describe.skipIf(!CAN_RUN)('yaac forward against a containerless server on this machine', () => {
  it('refuses, because the workspace already binds the host port itself', async () => {
    // Workspace ports are already this host's ports, so a forwarder here
    // would fight the dev servers for them (docs/port-forward-tunnel.md).
    // The refusal depends only on the server, so no workspace is named.
    const { exitCode, stderr } = await runYaac(serverEnv, 'forward')
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/containerless driver/)
    expect(stderr).toMatch(/nothing to tunnel/)
  })
})

/**
 * The `--group` flag of `yaac workspace create`. The k8s suite covers the
 * same server code through `yaac-mama create --group`.
 */
describe.skipIf(!CAN_RUN)('yaac workspace create --group', () => {
  it('creates the named group and files the new workspace into it', async () => {
    const before = new Set((await listWorkspaces()).map((w) => w.workspaceId))
    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'workspace', 'create', SLUG, '--tool', 'claude', '--group', 'friday batch',
    )
    if (exitCode !== 0) {
      throw new Error(`create failed (exit ${String(exitCode)})\n${stdout}\n${stderr}`)
    }
    const fresh = (await listWorkspaces()).find((w) => !before.has(w.workspaceId))
    expect(fresh).toBeDefined()

    // The group is created by name.
    const res = await fetch(`${origin()}/api/workspace/group/list?project=${SLUG}`)
    const { groups } = await res.json() as { groups: Array<{ groupId: string; name: string }> }
    const made = groups.find((g) => g.name === 'friday batch')
    expect(made).toBeDefined()

    // And the workspace is filed in it.
    const listed = await runYaac(serverEnv, 'workspace', 'list', SLUG)
    expect(listed.stdout).toMatch(new RegExp(`${fresh!.workspaceId.slice(0, 8)}[^\\n]*friday batch`))

    await runYaac(serverEnv, 'workspace', 'stop', fresh!.workspaceId)
  }, 180_000)
})

/** An agent that is installed but exits as soon as it launches. */
describe.skipIf(!CAN_RUN)('an agent that dies the moment it launches', () => {
  it('reports it as a failed provisioning row instead of a workspace that vanishes', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    try {
      // The fake codex exits 127 with `--model sick`, so tmux closes the
      // window, though `respawn-window` reports success.
      const { exitCode } = await runYaac(
        serverEnv, 'workspace', 'create', SLUG, '--tool', 'codex', '--mode', 'tui', '--model', 'sick',
      )
      // Create succeeds: the launch check runs afterwards, so it never
      // slows a create down.
      expect(exitCode).toBe(0)

      await vi.waitFor(() => {
        const row = watch.latest()?.provisioning.find((p) => p.tool === 'codex' && p.error)
        expect(row?.error).toMatch(/exited right after launch/)
        // Containerless rows also name the package to check.
        expect(row?.error).toContain(`@openai/codex@${AGENT_PACKAGES.codex.version}`)
      }, { timeout: 30_000, interval: 250 })
    } finally {
      watch.ws.close()
    }
  }, 180_000)
})

/**
 * Queued workspaces (docs/queued-workspaces.md): a queued workspace starts
 * when its parent is stopped, and stays queued if the parent dies instead.
 */
describe.skipIf(!CAN_RUN)('queued workspaces', () => {
  /** `yaac-mama` as the workspace `id` runs it, with its own credentials. */
  async function mamaAs(id: string, ...args: string[]): Promise<string> {
    const pid = (await tmux(id, 'display-message', '-p', '-t', 'yaac', '#{pane_pid}')).trim()
    const env = Object.fromEntries((await fs.readFile(`/proc/${pid}/environ`, 'utf8'))
      .split('\0').filter((e) => e.includes('=')).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `YAAC_MAMA_URL='${env.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${env.YAAC_MAMA_TOKEN}' `
      + `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted}`,
    ])
    return stdout.trim()
  }

  it('starts the top of a chain when its parent is stopped, with its prompt delivered', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    const latest = (): ServerSnapshot => {
      const snap = watch.latest()
      if (!snap) throw new Error('no snapshot yet')
      return snap
    }
    let childWorkspace: string | undefined
    try {
      // An explicit posture, since earlier cases change the remembered one
      // and it is the ceiling checked below.
      const parent = await createWorkspace('--permission-mode', 'accept-edits')
      await expect(mamaAs(parent, 'queue', '--parent-workspace', parent, '--tool', 'codex', '--permission-mode', 'bypass', 'x'))
        .rejects.toThrow(/more permissive than this workspace's own \('accept-edits'\)/)
      // The parent is never implied.
      await expect(mamaAs(parent, 'queue', 'x')).rejects.toThrow(/usage: yaac-mama queue --parent-workspace/)
      // The fake codex reports a conversation only once it gets a prompt,
      // and logs its launch arguments. All of these come from the edit.
      const child = await mamaAs(parent, 'queue', '--parent-workspace', parent, 'draft')
      await expect(mamaAs(parent, 'edit-queued', child.slice(0, 8), ''))
        .rejects.toThrow(/usage: yaac-mama edit-queued/)
      expect(await mamaAs(
        parent, 'edit-queued', '--tool', 'codex', '--model', 'gpt-5.5', '--permission-mode', 'read-only',
        '--title', 'Say hello', child.slice(0, 8), 'hello',
      )).toContain(`Updated queued workspace ${child.slice(0, 8)}: codex gpt-5.5, read-only — hello`)
      // Moved from the parent to the child; if the move were lost, the
      // parent's stop would launch it too.
      const grandchild = await mamaAs(parent, 'queue', '--parent-workspace', parent, 'after that')
      expect(await mamaAs(
        parent, 'edit-queued', '--parent-workspace', child.slice(0, 8), '--ui-mode', 'acp',
        '--branch', 'release/next', '--group', 'e2e follow-ups', grandchild.slice(0, 8),
      )).toContain('after that')
      expect(child).toMatch(/^[0-9a-f-]{36}$/)
      expect(await mamaAs(parent, 'list')).toContain('after that')

      const { exitCode } = await runYaac(serverEnv, 'workspace', 'stop', parent)
      expect(exitCode).toBe(0)

      await vi.waitFor(() => {
        childWorkspace = latest().workspaces.find((w) => w.prompt === 'hello')?.workspaceId
        expect(childWorkspace).toBeDefined()
      }, { timeout: 60_000, interval: 250 })
      await vi.waitFor(() => {
        expect(latest().workspaces.find((w) => w.workspaceId === childWorkspace)?.title).toBe('Say hello')
      }, { timeout: 60_000, interval: 250 })
      await vi.waitFor(() => {
        const sessions = latest().workspaces.find((w) => w.workspaceId === childWorkspace)?.agentSessions ?? []
        expect(sessions.some((a) => /^thread-\d+$/.test(a.agentSessionId))).toBe(true)
      }, { timeout: 30_000, interval: 250 })
      const launches = await fs.readFile(
        path.join(testEnv.dataDir, 'global', 'projects', SLUG, 'codex', `launches-${childWorkspace}`), 'utf8',
      )
      expect(launches).toContain('--sandbox read-only')
      expect(launches).toContain('--model gpt-5.5')

      // The grandchild waits for the child's own stop.
      const entry = latest().queuedWorkspaces.find((q) => q.id === grandchild)
      const group = latest().workspaceGroups.find((g) => g.projectSlug === SLUG && g.name === 'e2e follow-ups')
      expect(entry).toMatchObject({
        parentWorkspaceId: childWorkspace, prompt: 'after that', mode: 'acp', branch: 'release/next',
        groupId: group?.groupId,
      })
      expect(group).toBeDefined()
      await fetch(`${origin()}/api/workspace/queue/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: grandchild }),
      })
    } finally {
      watch.ws.close()
      if (childWorkspace !== undefined) await runYaac(serverEnv, 'workspace', 'stop', childWorkspace)
    }
  }, 240_000)

  it('keeps a dead parent\'s child queued and the parent held, until the child is discarded', async () => {
    const watch = collectSnapshots(server.lock.port)
    await watch.opened
    const latest = (): ServerSnapshot => {
      const snap = watch.latest()
      if (!snap) throw new Error('no snapshot yet')
      return snap
    }
    try {
      const parent = await createWorkspace()
      const res = await fetch(`${origin()}/api/workspace/queue/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: SLUG, parent, prompt: 'never on a crash' }),
      })
      expect(res.status).toBe(200)
      const { id } = await res.json() as { id: string }

      // Killing tmux directly is a death, not a stop. Past the starting
      // grace, the reaper takes it on the pass the dropped stream triggers.
      // The wait also outlasts create's ~1s launch probe, which would report
      // an earlier death as a failed launch whose provisioning row hides the
      // held one.
      await new Promise((r) => setTimeout(r, STARTING_GRACE_MS))
      await tmux(parent, 'kill-server').catch(() => undefined)
      await vi.waitFor(() => {
        expect(latest().heldWorkspaces.map((h) => h.workspaceId)).toContain(parent)
      }, { timeout: 20_000, interval: 250 })
      expect(latest().heldWorkspaces.find((h) => h.workspaceId === parent)?.deathReason).toBe('agent-exited')
      expect(latest().queuedWorkspaces.map((q) => q.id)).toContain(id)
      expect(latest().workspaces.find((w) => w.prompt === 'never on a crash')).toBeUndefined()

      const discarded = await fetch(`${origin()}/api/workspace/queue/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      expect(discarded.status).toBe(204)
      await vi.waitFor(() => {
        expect(latest().heldWorkspaces.map((h) => h.workspaceId)).not.toContain(parent)
      }, { timeout: 10_000, interval: 250 })
    } finally {
      watch.ws.close()
    }
  }, 60_000)
})
