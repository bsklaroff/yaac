import { expect, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TEST_CLI_ENTRY, createYaacTestEnv, spawnYaacServer, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, type SpawnedServer } from '@yaac/test-utils/api'
import { createTestRepo } from '@yaac/test-utils/setup'
import { addTestProject } from '#support/cluster'
import {
  containerlessJobName,
  containerlessWorkspacePaths,
} from '@yaac/server/drivers/containerless/paths'
import { AGENT_PACKAGES, agentPackagePrefix } from '@yaac/shared/tool-install'
import { ACP_ADAPTERS, AGENT_TOOLS } from '@yaac/shared/types'
import type {
  ConversationEntry,
  AgentTool,
  SessionEntry,
  WorkspaceTerminalEntry,
} from '@yaac/shared/types'

const execFileAsync = promisify(execFile)

/**
 * The rig of the containerless workspace suites
 * (test/e2e-containerless/workspace-*-suite.test.ts): one test env, server
 * and project per file, the fake agents its workspaces launch, and the
 * helpers that read a workspace through tmux, the API and its files
 * (docs/containerless-driver.md).
 *
 * The host needs `tmux` and `git`. Agent CLIs are faked, staged where yaac
 * installs the pinned ones: the launch, exec, port scan and recovery under
 * test do not depend on the agent, and a real one would need credentials.
 */

export let testEnv: YaacTestEnv
export let server: SpawnedServer
export let serverEnv: NodeJS.ProcessEnv
export let repoPath: string
/** The project's id, minted when beforeAll adds it as `NAME`. */
export let projectId: string

export const NAME = 'cl-demo'
/** The project's git credential: an HTTPS token, assigned in beforeAll. */
export const GIT_TOKEN = 'ghp_containerless_test'
/**
 * The server's starting grace, shortened so the stale reaper takes a dead
 * workspace on the pass its stream drop triggers rather than a minute later.
 */
export const STARTING_GRACE_MS = 5_000

/** Whether this host has the binaries `yaac host check` requires. */
export async function hostReady(): Promise<boolean> {
  for (const bin of ['tmux', 'git']) {
    try {
      await execFileAsync('sh', ['-c', `command -v ${bin}`])
    } catch {
      return false
    }
  }
  return true
}

export const CAN_RUN = await hostReady()

/**
 * Whether this host can run the acp cases. The adapter is faked, but the
 * chat transport needs a real `socat` to reach acpd's socket.
 */
export const CAN_RUN_ACP = CAN_RUN
  && await execFileAsync('sh', ['-c', 'command -v socat']).then(() => true, () => false)

/** A loopback address other than 127.0.0.1. macOS routes only 127.0.0.1 of
 *  127.0.0.0/8, so it uses the IPv6 loopback. */
export const OTHER_LOOPBACK = process.platform === 'linux' ? '127.0.0.2' : '::1'

/** Whether port detection works here: it uses `lsof`, and reports nothing without it. */
export const CAN_RUN_PORTS = CAN_RUN
  && await execFileAsync('sh', ['-c', 'command -v lsof']).then(() => true, () => false)

/**
 * The first lines of each fake terminal agent: one handed an opening
 * message off a terminal runs it once and exits, as pi does, so a launch
 * that takes the pane's terminal from its agent fails here rather than only
 * with the real tool.
 */
export const OPENING_GUARD = 'case " $* " in *" -- "*|*" --prompt="*) [ -t 0 ] && [ -t 1 ] || exit 0 ;; esac'

/**
 * A fake codex that mimics what yaac sees from codex-cli. On the first
 * prompt, its launch argument or else its first line of input, it reports
 * the conversation (with its rollout path) through the SessionStart hook,
 * then the throwaway title session (no rollout). A resume reports nothing. Each launch's arguments are logged per workspace for the
 * restart case, and each later line it is sent for `yaac-mama send`. It keeps
 * reading, as a real TUI does: some terminals echo nothing typed behind an
 * unread line, and the paste submits only once it sees its text. Below each
 * line it prints a footer and an empty codex composer, leaving the cursor in
 * it as codex does, which a message to a running agent looks for
 * (`buildMessageCmd`). With `--model sick` it fails to start.
 *
 * It calls the hook script directly; that real codex runs it is checked
 * against the pinned binary (see `ensureAgentReporters`).
 */
export const FAKE_CODEX = [
  '#!/bin/sh',
  OPENING_GUARD,
  'case " $* " in *" --model sick "*) echo "codex: cannot execute" >&2; exit 127 ;; esac',
  'printf \'%s\\n\' "$*" >> "$CODEX_HOME/launches-${PWD##*/}"',
  'case " $* " in *" resume "*) exec sleep 2147483647 ;; esac',
  'case " $* " in *" -- "*) ;; *) read -r _ || exec sleep 2147483647 ;; esac',
  'mkdir -p "$CODEX_HOME/sessions"',
  'rollout="$CODEX_HOME/sessions/rollout-2026-10-03T12-00-00-thread-$$.jsonl"',
  ': > "$rollout"',
  'printf \'{"session_id":"thread-%s","transcript_path":"%s"}\' $$ "$rollout" | yaac-agent-links "$CODEX_HOME" codex',
  'printf \'{"session_id":"title-%s","transcript_path":null}\' $$ | yaac-agent-links "$CODEX_HOME" codex',
  "printf '  ? for shortcuts\\n› '",
  'while read -r line; do printf \'%s\\n\' "$line" >> "$CODEX_HOME/sent-${PWD##*/}"; printf \'  ? for shortcuts\\n› \'; done',
  'exec sleep 2147483647',
  '',
].join('\n')

/** Where the server finds yaac's own install of `binary`. */
export const managedBin = (binary: string): string =>
  path.join(agentPackagePrefix(AGENT_PACKAGES[binary]), 'bin', binary)

/**
 * Stage fake agents where yaac installs the pinned ones, so create installs
 * nothing. Each holds its tmux window open like a real TUI; otherwise the
 * window, and with it the workspace, would end at once. `codex` is
 * `FAKE_CODEX`.
 *
 * ACP adapters are faked too (`fakeAcpAdapter`), one per adapter binary.
 * opencode's and omp's adapters are their CLI's `acp` subcommand, so each
 * fake is both. omp runs under bun, whose install a launch also checks for.
 */
export async function installFakeAgents(): Promise<void> {
  await fs.mkdir(agentEnvDir(), { recursive: true })
  // The fake adapters are CommonJS scripts with no extension. A package.json
  // of their own stops node reading them as modules of whatever package the
  // scratch dir sits in: this checkout's, when it is under a dev workspace.
  const tools = path.dirname(agentPackagePrefix(AGENT_PACKAGES.claude))
  await fs.mkdir(tools, { recursive: true })
  await fs.writeFile(path.join(tools, 'package.json'), '{}')
  const reportEnv = `env > '${agentEnvDir()}'/$$.env; printf '%s\\0' "$@" > '${agentEnvDir()}'/\${YAAC_SESSION_ID:-$$}.argv\n`
  // `dir`: the binary whose install dir the file goes in. A shell agent
  // reports its environment and arguments first (`processEnv`,
  // `sessionArgv`).
  const write = async (name: string, body: string, dir = name): Promise<string> => {
    const file = path.join(path.dirname(managedBin(dir)), name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body.replace(/^#!\/bin\/sh\n/, (shebang) => shebang + reportEnv))
    await fs.chmod(file, 0o755)
    return file
  }
  for (const tool of ['claude', 'pi']) {
    await write(tool, `#!/bin/sh\n${OPENING_GUARD}\nexec sleep 2147483647\n`)
  }
  await write('bun', '#!/bin/sh\nexec sleep 2147483647\n')
  await write('codex', FAKE_CODEX)

  for (const tool of AGENT_TOOLS) {
    const { binary } = ACP_ADAPTERS[tool]
    if (binary === tool) continue
    await write(binary, fakeAcpAdapter(tool))
  }
  // `exec` so the adapter itself owns acpd's stdio.
  for (const tool of ['opencode', 'omp'] as const) {
    await write(`${tool}-acp-impl`, fakeAcpAdapter(tool), tool)
    await write(
      tool,
      '#!/bin/sh\n'
      + `if [ "$1" = "acp" ]; then shift; exec ${tool}-acp-impl "$@"; fi\n`
      + `${OPENING_GUARD}\nexec sleep 2147483647\n`,
    )
  }
}

/**
 * The modes each fake ACP adapter advertises: the ones yaac maps postures
 * onto. The real adapters are checked against these at their pinned
 * versions (workspace-create-suite).
 */
export const ACP_MODES: Record<AgentTool, { current: string; available: string[] }> = {
  claude: { current: 'default', available: ['default', 'acceptEdits', 'plan', 'bypassPermissions'] },
  // codex-acp's real default. Getting it wrong would change whether
  // `applyPermissionMode` sends a switch at all.
  codex: { current: 'agent', available: ['read-only', 'workspace-write', 'agent', 'agent-full-access'] },
  opencode: { current: 'build', available: ['build', 'plan'] },
  // pi advertises thinking levels, which yaac never sets.
  pi: { current: 'medium', available: ['off', 'medium', 'high'] },
  omp: { current: 'default', available: ['default', 'plan'] },
}

/**
 * The `session/new` mode fields, in each adapter's own format. opencode v2
 * sends only `configOptions` (a `mode` select), which `acpModeOffered`
 * handles; the others send `modes`.
 */
export function sessionModesReply(tool: AgentTool): Record<string, unknown> {
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
export const ACP_ADAPTER_DIES = 'acp-adapter-dies'

/**
 * A prompt that makes the fake adapters switch themselves into plan mode
 * (as claude's EnterPlanMode does), or into any mode as `enter <id> mode`.
 */
export const ENTER_PLAN_MODE = 'enter plan mode'

/**
 * A fake ACP adapter: line-delimited JSON-RPC on stdio that answers the
 * handshake and little else. Its session id names the tool, and it reports
 * its `cwd` to show acpd spawned it in the checkout. As claude, a prompt
 * writes the conversation's transcript, which a restart checks is there.
 */
export const fakeAcpAdapter = (tool: AgentTool): string => `#!/usr/bin/env node
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
    if (msg.method === 'session/prompt' && '${tool}' === 'claude') {
      const dir = require('path').join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'e2e')
      require('fs').mkdirSync(dir, { recursive: true })
      require('fs').appendFileSync(require('path').join(dir, msg.params.sessionId + '.jsonl'), line + '\\n')
    }
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
export const origin = (): string => `http://127.0.0.1:${String(server.lock.port)}`

/** The main clone of a staged project's repo, which carries the project's
 *  id (`addTestProject`). */
export const mainClone = (id = projectId): string => path.join(testEnv.dataDir, 'global', 'repos', id)

/** The tmux socket the driver uses for a workspace. */
export function sockFor(id: string): string {
  return containerlessWorkspacePaths(containerlessJobName(projectId, id)).tmuxSock
}

export interface ListedWorkspace {
  workspaceId: string
  projectId: string
  prompt?: string
  deadline?: string
  routineId?: string
  status: string
  title?: string
  groupId?: string
  forwardedPorts: Array<{ containerPort: number; hostPort: number }>
  conversations: ConversationEntry[]
  sessions: SessionEntry[]
  terminals?: WorkspaceTerminalEntry[]
}

/** The workspaces the server currently reports, newest first. */
export async function listWorkspaces(): Promise<ListedWorkspace[]> {
  const res = await fetch(`${origin()}/api/workspace/list`)
  const body = await res.json() as { workspaces: ListedWorkspace[] }
  return body.workspaces
}

/** Run `yaac forward` as a long-lived child, with a wait for its listener. */
export function startForwardCli(...args: string[]): {
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

/** Create a claude workspace and return its id. */
export async function createWorkspace(...extra: string[]): Promise<string> {
  return createWorkspaceWith('claude', ...extra)
}

/** `createWorkspace` for a given tool, in `tui` unless `extra` names a mode. */
export async function createWorkspaceWith(tool: string, ...extra: string[]): Promise<string> {
  return (await createWorkspaceFrom('--tool', tool, '--mode', 'tui', ...extra)).workspaceId
}

/** Run `yaac workspace create` with exactly `args`; the new id and stdout. */
export async function createWorkspaceFrom(...args: string[]): Promise<{ workspaceId: string; stdout: string }> {
  const { stdout, stderr, exitCode } = await runYaac(cliEnv(), 'workspace', 'create', NAME, ...args)
  if (exitCode !== 0) {
    throw new Error(`create failed (exit ${String(exitCode)})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  return { workspaceId: startedId(stdout), stdout }
}

/**
 * The id of the workspace a `yaac workspace create` started, as the CLI
 * prints it. Diffing the listing instead would race the queued children,
 * timeouts and scheduled starts this file sets off on the server's clock.
 */
export function startedId(stdout: string): string {
  const id = /^(?:Non-interactive )?Workspace ([0-9a-f-]{36}) is running/m.exec(stdout)?.[1]
  if (id === undefined) throw new Error(`create printed no workspace id:\n${stdout}`)
  return id
}

/** The zone the CLI reports at create, unlike the server's own `TZ`. */
export const CLI_TIME_ZONE = 'Pacific/Auckland'

/**
 * The CLI's environment: a device in `CLI_TIME_ZONE`, and not inside a
 * workspace (which this suite may itself run in), so it reports its zone.
 */
export function cliEnv(): NodeJS.ProcessEnv {
  return { ...serverEnv, TZ: CLI_TIME_ZONE, YAAC_WORKSPACE_ID: undefined, YAAC_WORKTREE_ID: undefined }
}

/** Run a tmux command against a workspace's own server. */
export async function tmux(id: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-S', sockFor(id), ...args])
  return stdout
}

/**
 * The environment a fake agent started with, which it writes to
 * `<agentEnvDir()>/<pid>.env` (see `installFakeAgents`). macOS hides other
 * processes' environments, so the agents report their own on every platform.
 */
export async function processEnv(pid: string): Promise<Record<string, string>> {
  const dump = await fs.readFile(path.join(agentEnvDir(), `${pid}.env`), 'utf8').catch(() => '')
  return Object.fromEntries(dump.split('\n').filter((e) => e.indexOf('=') > 0)
    .map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
}

export const agentEnvDir = (): string => path.join(testEnv.scratchDir, 'agent-env')

/** The server user's HOME, which workspaces run on. */
export const userHome = (): string => path.join(testEnv.scratchDir, 'home')

/** The user shell the rc case runs in: zsh, else bash, else none. */
export const USER_SHELL = CAN_RUN
  ? (await execFileAsync('sh', ['-c', 'command -v zsh || command -v bash']).catch(() => ({ stdout: '' }))).stdout.trim()
  : ''

/**
 * The user's own rc files, which re-point a tool home and gh's token, put
 * their own bin dir first and name a yaac data dir, as a real user's may.
 * Launches and panes read them; yaac's settings must still win there, and
 * the rest is the user's.
 */
export async function writeUserRc(): Promise<void> {
  const exports = 'export CLAUDE_CONFIG_DIR=/from/user/rc\nexport PATH=/from/user/rc/bin:$PATH\n'
    + 'export GH_TOKEN=from-user-rc\n'
  // Interactive only: the CLI's own pty runs (`script`) start `zsh -c`,
  // which reads .zshenv, and must keep the test's data dir.
  const dataDir = 'export YAAC_DATA_DIR=/from/user/rc/yaac\n'
  await fs.mkdir(userHome(), { recursive: true })
  await fs.writeFile(path.join(userHome(), '.zshenv'), exports)
  await fs.writeFile(path.join(userHome(), '.zshrc'), `${dataDir}PROMPT='%~ %# '\n`)
  await fs.writeFile(path.join(userHome(), '.bash_profile'), `${exports}${dataDir}PS1='\\w\\$ '\n`)
}

/** Workspace `id`'s first session, listed as `headers` asks. */
export async function firstSession(id: string, headers: Record<string, string> = {}): Promise<SessionEntry> {
  const { workspaces } = await (await fetch(`${origin()}/api/workspace/list`, { headers })).json() as {
    workspaces: Array<{ workspaceId: string; sessions: SessionEntry[] }>
  }
  const session = workspaces.find((w) => w.workspaceId === id)?.sessions[0]
  if (session === undefined) throw new Error(`workspace ${id} has no session`)
  return session
}

/**
 * Name the conversation of workspace `id`'s first session on its pane, as
 * claude's SessionStart hook would (the fake claude reports nothing), and
 * wait for the server to link it. A fresh claude session's conversation id
 * is the session's own, which this returns.
 */
export async function reportClaudeConversation(
  project: string,
  id: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const session = await firstSession(id, headers)
  const sock = containerlessWorkspacePaths(containerlessJobName(project, id)).tmuxSock
  await execFileAsync('tmux', ['-S', sock, 'set-option', '-p', '-t', `yaac:${session.window}`,
    '@yaac-session', `claude|${session.sessionId}|`])
  await vi.waitFor(async () => {
    const linked = await (await fetch(`${origin()}/api/workspace/${id}/conversations`, { headers })).json() as
      Array<{ conversationId: string }>
    expect(linked.map((c) => c.conversationId)).toContain(session.sessionId)
  }, { timeout: 30_000, interval: 250 })
  return session.sessionId
}

/**
 * The environment of workspace `id`'s first session's agent, which the fake
 * agent dumps as it starts. `show-environment` shows what future panes get
 * rather than what the launch set, and running `printenv` in a new window
 * would change the shared fixture.
 */
export async function paneEnv(id: string): Promise<Record<string, string>> {
  let env: Record<string, string> = {}
  await vi.waitFor(async () => {
    env = await processEnv((await tmux(id, 'display-message', '-p', '-t', `yaac:${(await firstSession(id)).window}`, '#{pane_pid}')).trim())
    expect(Object.keys(env)).not.toHaveLength(0)
  }, { timeout: 30_000, interval: 250 })
  return env
}

/** The arguments workspace `id`'s first session's agent was launched with,
 *  which the fake agent dumps under its session as it starts, whatever
 *  process it runs under. */
export async function sessionArgv(id: string): Promise<string[]> {
  const file = path.join(agentEnvDir(), `${(await firstSession(id)).sessionId}.argv`)
  return (await fs.readFile(file, 'utf8').catch(() => '')).split('\0').slice(0, -1)
}

/** A process's direct children. */
export async function childPids(pid: string): Promise<string[]> {
  const out = process.platform === 'linux'
    ? await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')
    : (await execFileAsync('pgrep', ['-P', pid]).catch(() => ({ stdout: '' }))).stdout
  return out.trim().split(/\s+/).filter(Boolean)
}

/** A variable from the workspace tmux server's environment, which every pane inherits. */
export async function workspaceEnvVar(id: string, name: string): Promise<string> {
  const line = (await tmux(id, 'show-environment', '-g', name)).trim()
  return line.startsWith(`${name}=`) ? line.slice(name.length + 1) : ''
}

/** Start the file's env, server and `NAME` project: its `beforeAll`. */
export async function startRig(): Promise<void> {
  if (!CAN_RUN) return
  testEnv = await createYaacTestEnv()
  await installFakeAgents()
  await writeUserRc()
  serverEnv = {
    ...testEnv.env,
    // Workspaces run on the user's own HOME and shell.
    HOME: userHome(),
    SHELL: USER_SHELL || '/bin/sh',
    ZDOTDIR: userHome(),
    // Create would otherwise attach a PTY and hang without a TTY.
    YAAC_E2E_NO_ATTACH: '1',
    // The project's remote is fake; skip the fetch.
    YAAC_E2E_SKIP_FETCH: '1',
    // Bogus tool homes in the server's own environment, which agents must
    // not inherit (checked by the tool-home case below).
    CLAUDE_CONFIG_DIR: '/nowhere/claude',
    CODEX_HOME: '/nowhere/codex',
    PI_CODING_AGENT_DIR: '/nowhere/pi',
    OMP_PROFILE: 'nowhere',
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
  // Set only inside a workspace, which this test run may itself be in.
  delete serverEnv.YAAC_USER_ZDOTDIR
  server = await spawnYaacServer(serverEnv)

  // Create needs a tool credential.
  await runYaac(serverEnv, 'auth', 'fake', 'claude-oauth')

  repoPath = await createTestRepo(path.join(testEnv.scratchDir, NAME))
  // A local path is refused as a remote, so use a GitHub URL that is never
  // fetched, with a git credential assigned.
  projectId = await addTestProject(server, repoPath, { remoteUrl: `https://github.com/test/${NAME}.git` })
  await assignTestGitCredential(server, NAME, GIT_TOKEN)
}

/** Stop them: its `afterAll`. */
export async function stopRig(): Promise<void> {
  if (!CAN_RUN) return
  // Optional chaining keeps a beforeAll failure from being hidden by a
  // TypeError here.
  await server?.stop()
  await testEnv?.cleanup()
}

/** Restart the server on the same data dir, in `env`. The workspaces'
 *  tmux servers outlive it. */
export async function restartServer(env: NodeJS.ProcessEnv = serverEnv): Promise<void> {
  await server.stop()
  server = await spawnYaacServer(env)
}
