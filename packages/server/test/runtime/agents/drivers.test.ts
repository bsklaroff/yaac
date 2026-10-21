import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir, codexDir } from '@yaac/shared/project-paths'
import {
  agentDriver,
  type AgentConnectDeps,
  type AgentObservation,
  type DrivenWorkspace,
} from '#runtime/agents/drivers'
// Imported so the test follows any change to the bound.
import { MAX_FAST_ATTACH_ATTEMPTS, setAcpPermissionMode } from '#runtime/agents/acp-driver'
import { OPENCODE_ACTIONS } from '#runtime/agents/agent-command'
import {
  _resetAcpRegistryForTests,
  acpConversation,
  acpConversationByHandle,
} from '#runtime/agents/acp-registry'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import type { StreamChild, WorkspaceDriver } from '#drivers/contract'
import { PromptNotRunError, type AcpConversation } from '#runtime/agents/acp-client'
import type { AcpEventInit } from '@yaac/shared/acp'
import {
  AGENT_TOOLS,
  SUPPORTED_PERMISSION_MODES,
} from '@yaac/shared/types'
import { _ACP_PROFILES, acpLaunchModel } from '#runtime/agents/acp-adapters'
import type { AgentTool, PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo, type PiProvider } from '@yaac/shared/tool-providers'

/** A pi conversation's model when none is named: the provider's default. */
const PI_DEFAULT_MODEL = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel

/**
 * Drives each agent driver as the status watcher does: connect, feed the
 * pod's side of the stream, and assert the observations. Only the driver's
 * dial and exec are mocked; tmux control mode, JSON-RPC and ACP handling run
 * for real.
 */

interface OpencodeConfig {
  model?: string
  default_agent?: string
  permissions?: Array<{ action: string; resource: string; effect: string }>
}

/** The config document an opencode launch carries in OPENCODE_CONFIG_CONTENT. */
function opencodeConfigOf(cmd: string): OpencodeConfig {
  const json = /OPENCODE_CONFIG_CONTENT="(\{.*?\})" /.exec(cmd)?.[1]
  return JSON.parse((json ?? '{}').replace(/\\"/g, '"')) as OpencodeConfig
}

/**
 * A tui conversation's launch line, as a create asks for one. `paths`
 * overrides the in-pod workspace dir.
 */
function tuiLaunchCmd(o: {
  tool: AgentTool
  workspaceId: string
  permissionMode: PermissionMode
  resume?: boolean
  model?: string
  effort?: string
  piProvider?: PiProvider
  paths?: { workspaceDir: string }
}): string {
  return agentDriver('tui').launchCmd({
    tool: o.tool,
    agentSessionId: o.workspaceId,
    resume: o.resume ?? false,
    windowName: o.tool,
    paths: { ...workspacePathsFixture(), ...o.paths },
    permissionMode: o.permissionMode,
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.effort !== undefined ? { effort: o.effort } : {}),
    ...(o.piProvider !== undefined ? { piProvider: o.piProvider } : {}),
  })
}

const podExec = vi.fn<WorkspaceDriver['exec']>()

/** A fake `ctrl` stream the test drives from the workspace's side. */
class FakeStream implements StreamChild {
  writes: string[] = []
  killed = false
  private dataCbs: Array<(chunk: Buffer | string) => void> = []
  private exitCbs: Array<(...args: unknown[]) => void> = []
  stdin = { write: (data: string): void => { this.writes.push(data) } }
  stdout = { on: (_e: 'data', cb: (chunk: Buffer | string) => void): void => { this.dataCbs.push(cb) } }
  stderr = { on: (): void => { /* unused */ } }
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void {
    if (event === 'exit') this.exitCbs.push(cb)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  /** Deliver bytes as if the pod sent them. Pass a Buffer to test decoding
   *  across chunk boundaries. */
  feed(data: string | Buffer): void {
    for (const cb of this.dataCbs) cb(data)
  }
  emitExit(): void {
    for (const cb of this.exitCbs) cb(0)
  }
  /** The JSON-RPC messages the driver has sent, parsed. */
  sent(): Array<Record<string, unknown>> {
    return this.writes.join('').split('\n').filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }
}

/** Wait for the driver to send `cmd`, then answer it with no output. */
async function answer(stream: FakeStream, cmd: string): Promise<void> {
  await vi.waitFor(() => expect(stream.writes.join('')).toContain(cmd))
  stream.feed('%begin 1 1 1\n%end 1 1 1\n')
}

/** The windows an acp connection's tmux client lists, one name per line. */
let tmuxWindows = ''
/** Listed windows still running create's placeholder. */
const placeholders = new Set<string>()
/** The last tmux client an acp connection dialed. */
let lastTmux: FakeTmux | undefined
/** Every `list-windows` answers with an error while set. */
let failRelist = false
/** Each listed window's pane pid; a respawn changes it. Default `100`. */
const panePids = new Map<string, string>()
/** Pane options set through `set-option -p`, by pane id. They survive a
 *  respawn, as in tmux. */
const paneOptions = new Map<string, string>()

/**
 * The workspace's tmux server as an acp connection's control-mode client
 * sees it: it lists `tmuxWindows`, the ones in `placeholders` as still
 * running the placeholder, and accepts every other command.
 */
class FakeTmux extends FakeStream {
  private bannerSent = false
  override stdin = {
    write: (data: string): void => {
      this.writes.push(data)
      const set = /^set-option -p -t (%\d+) @yaac-acp-session '(.*)'/.exec(data)
      if (set) paneOptions.set(set[1], set[2])
      const relist = data.startsWith('list-windows')
      const body = relist
        ? tmuxWindows.split('\n').filter((w) => w !== '')
          .map((w, i) => `${w}\t%${String(i)}\t${placeholders.has(w) ? '1' : '0'}`
            + `\t${panePids.get(w) ?? '100'}\t${paneOptions.get(`%${String(i)}`) ?? ''}\n`).join('')
        : ''
      const banner = this.bannerSent ? '' : '%begin 0 0 0\n%end 0 0 0\n'
      this.bannerSent = true
      const reply = relist && failRelist
        ? '%begin 1 1 1\nno server running\n%error 1 1 1\n'
        : `%begin 1 1 1\n${body}%end 1 1 1\n`
      queueMicrotask(() => this.feed(`${banner}${reply}`))
    },
  }
}

/**
 * The workspace's tmux server as a tui connection's control-mode client sees
 * it: it lists `panes` (`<pane id>\t<window name>`, none a placeholder or
 * naming a conversation) and accepts every other command.
 */
class FakeTuiTmux extends FakeStream {
  private bannerSent = false
  constructor(private readonly panes: string[]) {
    super()
  }

  override stdin = {
    write: (data: string): void => {
      this.writes.push(data)
      const body = data.startsWith('list-panes') ? this.panes.map((p) => `${p}\t0\t\n`).join('') : ''
      const banner = this.bannerSent ? '' : '%begin 0 0 0\n%end 0 0 0\n'
      this.bannerSent = true
      queueMicrotask(() => this.feed(`${banner}%begin 1 1 1\n${body}%end 1 1 1\n`))
    },
  }
}

/** An acp dial: a `FakeTmux` for the control-mode attach, `acpd` for each
 *  conversation's socket. */
function acpDial(acpd: (s: DrivenWorkspace, argv: string[]) => StreamChild): NonNullable<AgentConnectDeps['dial']> {
  return (s, argv) => (argv[0] === 'tmux' ? (lastTmux = new FakeTmux()) : acpd(s, argv))
}

const session: DrivenWorkspace = {
  projectId: 'demo',
  workspaceId: 'wt-1',
  jobName: 'yaac-demo-wt-1',
  tool: 'claude',
}

const connections: Array<{ close(): void }> = []

/** Collect a conversation's events; it keeps no history itself. */
function collect(conversation: AcpConversation): AcpEventInit[] {
  const events: AcpEventInit[] = []
  conversation.subscribe((e) => events.push(e))
  return events
}

/**
 * Write the log acpd would have left, which is how a reattaching connection
 * learns what the agent is doing.
 */
async function record(agentSessionId: string, lines: unknown[]): Promise<void> {
  const dir = acpLogDir(session.projectId, session.workspaceId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${agentSessionId}.jsonl`),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
  )
}

/** The run header acpd writes first in every log. */
const lifeLine = {
  jsonrpc: '2.0',
  method: '_acpd/life',
  params: { id: 'life-1', startedAt: '2026-01-01T00:00:00.000Z' },
}

/** The log of a handshake that left the session in `modeId`, which is how a
 *  reattach learns the posture. */
const recordMode = (agentSessionId: string, modeId: string): Promise<void> => record(agentSessionId, [
  ...handshakeOnly(agentSessionId, 'default'),
  { jsonrpc: '2.0', id: 'h-2', method: 'session/set_mode', params: { sessionId: agentSessionId, modeId } },
  { jsonrpc: '2.0', id: 'h-2', result: {} },
])

/** The log of a handshake cut off after `session/new` answered, in `modeId`,
 *  before its effort and posture calls. */
const handshakeOnly = (agentSessionId: string, modeId: string): unknown[] => [
  lifeLine,
  { jsonrpc: '2.0', id: 'h-1', method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } },
  { jsonrpc: '2.0', id: 'h-1', result: { sessionId: agentSessionId, modes: {
    currentModeId: modeId, availableModes: [{ id: 'default' }, { id: 'acceptEdits' }, { id: 'bypassPermissions' }],
  } } },
]

/** A prompt as logged: the client's request, with the id its reply will use. */
const promptLine = (agentSessionId: string, id: string, text: string): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'session/prompt',
  params: { sessionId: agentSessionId, prompt: [{ type: 'text', text }] },
})

const helloLine = (firstAttach: boolean): string =>
  `${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach } })}\n`

/** Every status this connection published, in order. */
const statuses = (seen: AgentObservation[]): string[] =>
  seen.flatMap((o) => (o.kind === 'status' ? [o.status] : []))

/** A permission ask's params, as the pinned claude adapter sends them. */
const askParams = {
  sessionId: 'acp-1',
  toolCall: { toolCallId: 'call-1', title: 'rm -rf build', kind: 'execute' },
  options: [
    { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    { optionId: 'yes-always', name: 'Always Allow', kind: 'allow_always' },
  ],
}

/** The agent's permission request, as a wire line. */
const permissionAsk = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: askParams })}\n`

/** A connection reattached to a running conversation under a given posture. */
async function attachedUnder(
  permissionMode: PermissionMode,
  agentSessionId: string,
): Promise<{ stream: FakeStream; seen: AgentObservation[] }> {
  const stream = new FakeStream()
  tmuxWindows = 'claude\n'
  const seen: AgentObservation[] = []
  connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
    dial: acpDial(() => stream),
    recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId }]),
    permissionMode: () => Promise.resolve(permissionMode),
    log: () => {},
  }))
  await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', agentSessionId)).toBeDefined())
  stream.feed(helloLine(false))
  return { stream, seen }
}

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-drivers-'))
  setDataDir(dataDir)
  _resetAcpRegistryForTests()
  podExec.mockReset()
  podExec.mockResolvedValue({ stdout: '', stderr: '' })
  tmuxWindows = ''
  failRelist = false
  placeholders.clear()
  panePids.clear()
  paneOptions.clear()
  installFakeWorkspaceDriver({ exec: podExec })
})

afterEach(async () => {
  for (const c of connections.splice(0)) c.close()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('agentDriver', () => {
  it('picks a driver per mode, and defaults everything else to tui', () => {
    expect(agentDriver('tui').mode).toBe('tui')
    expect(agentDriver('acp').mode).toBe('acp')
  })

  it('launches a tui conversation as the tool itself and an acp one under acpd', () => {
    const spec = {
      tool: 'claude' as const,
      agentSessionId: 'conv-1',
      resume: false,
      windowName: 'claude-2',
      paths: workspacePathsFixture(),
      permissionMode: 'bypass' as const,
    }
    // TUI: the tool's own binary.
    expect(agentDriver('tui').launchCmd(spec)).toContain('claude --permission-mode bypassPermissions')
    expect(agentDriver('tui').launchCmd(spec)).toContain('--session-id conv-1')

    // ACP: acpd supervising the adapter, its socket named for the window.
    const acp = agentDriver('acp').launchCmd(spec)
    expect(acp).toContain('node /opt/yaac/acpd/main.js')
    // The protocol reports the conversation, so the pane reporters skip.
    expect(acp).toMatch(/^YAAC_NO_PANE_REPORT=1 node /)
    expect(agentDriver('tui').launchCmd(spec)).not.toContain('YAAC_NO_PANE_REPORT')
    expect(acp).toContain('--sock /tmp/yaac-acp/claude-2.sock')
    expect(acp).toContain('-- claude-agent-acp')
    // Explicit cwd: acpd cannot know where the checkout is.
    expect(acp).toContain('--cwd /workspace')
    // The log is named for the conversation, not the window, since window
    // names can shift between restarts.
    expect(acp).toContain('--log /home/yaac/.yaac-acp/conv-1.jsonl')
    // Resuming is a `session/load` call after connecting, not a flag.
    expect(acp).not.toContain('resume')
    // Embedded in a single-quoted respawn-window, so no quotes.
    expect(acp).not.toContain("'")
    // Started ahead of its checkout, acpd holds the conversation until the
    // checkout's `.git` lands.
    expect(acp).not.toContain('--wait-for')
    expect(agentDriver('acp').launchCmd({ ...spec, beforeCheckout: true }))
      .toContain('--cwd /workspace --wait-for /workspace/.git --')
    // The adapter takes no flags, so the model goes in an env var.
    const withModel = agentDriver('acp').launchCmd({ ...spec, model: 'claude-opus-5-5' })
    expect(withModel).toMatch(/^ANTHROPIC_MODEL=claude-opus-5-5 YAAC_NO_PANE_REPORT=1 node /)
    expect(withModel).not.toContain('--model')
    // A 1M-context model is quoted, since a bare `[1m]` is a shell glob.
    expect(agentDriver('acp').launchCmd({ ...spec, model: 'claude-opus-5-5[1m]' }))
      .toMatch(/^ANTHROPIC_MODEL="claude-opus-5-5\[1m\]" YAAC_NO_PANE_REPORT=1 node /)
    // A model reaches here from a request, a queued child's parent or a
    // restarted conversation's report, which anything in the workspace can
    // set; every launch refuses one it cannot carry.
    for (const mode of ['tui', 'acp'] as const) {
      for (const model of ['x; touch /tmp/pwned; #', '-cx', 'a b', 'x[1m][1m]']) {
        expect(() => agentDriver(mode).launchCmd({ ...spec, model }), `${mode} ${model}`).toThrow(/invalid model/)
      }
      // `[1m]` is claude's alone.
      expect(() => agentDriver(mode).launchCmd({ ...spec, tool: 'codex', model: 'gpt-5.5[1m]' })).toThrow(/invalid model/)
    }
  })

  it('offers a mode id only for postures create will let through', () => {
    // Postures without a mode id are carried another way (opencode's launch
    // config) or not at all (pi).
    for (const tool of AGENT_TOOLS) {
      const modeIdPostures = Object.keys(_ACP_PROFILES[tool].modeIds) as PermissionMode[]
      expect(modeIdPostures.filter((m) => !SUPPORTED_PERMISSION_MODES[tool].includes(m)), tool).toEqual([])
    }
    // claude and codex name a mode for every posture they have.
    for (const tool of ['claude', 'codex'] as const) {
      expect(SUPPORTED_PERMISSION_MODES[tool].filter((m) => _ACP_PROFILES[tool].modeIds[m] === undefined), tool)
        .toEqual([])
    }
    expect(_ACP_PROFILES.opencode.modeIds).toEqual({ plan: 'plan' })
    expect(_ACP_PROFILES.pi.modeIds).toEqual({})
  })

  it("launches each tool's adapter the way that adapter takes its configuration", () => {
    const spec = (tool: 'codex' | 'opencode' | 'pi', over: Record<string, unknown> = {}) =>
      agentDriver('acp').launchCmd({
        tool,
        agentSessionId: 'conv-1',
        resume: false,
        windowName: tool,
        paths: workspacePathsFixture(),
        permissionMode: 'bypass',
        ...over,
      } as never)

    // codex-acp takes no flags: the posture's settings and the model go
    // through the environment, so a loaded thread starts in its posture
    // rather than the one it last ran in. Browser login is disabled since a
    // workspace cannot open one.
    const codexConfig = (cmd: string): unknown =>
      JSON.parse(/CODEX_CONFIG="((?:[^"\\]|\\.)*)"/.exec(cmd)![1].replace(/\\(.)/g, '$1'))
    const codex = spec('codex')
    expect(codex).toContain('-- codex-acp')
    expect(codex).toMatch(/NO_BROWSER=1 CODEX_PATH=codex CODEX_CONFIG=\S+ YAAC_NO_PANE_REPORT=1 node \/opt\/yaac\/acpd\/main\.js/)
    expect(codexConfig(codex))
      .toEqual({ approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access' })
    expect(codexConfig(spec('codex', { permissionMode: 'auto' })))
      .toEqual({ approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write' })
    expect(codexConfig(spec('codex', { permissionMode: 'accept-edits', model: 'gpt-5.2-codex' }))).toEqual({
      approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write', model: 'gpt-5.2-codex',
    })
    // A posture codex lacks launches as its strictest, as the TUI does.
    expect(codexConfig(spec('codex', { permissionMode: 'plan' })))
      .toEqual({ approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'read-only' })

    // opencode is its own adapter, with the same posture config as its TUI.
    const opencode = spec('opencode')
    expect(opencode).toContain('-- opencode acp')
    expect(opencode).toContain('OPENCODE_CONFIG_CONTENT=')
    expect(opencode).toContain('\\"effect\\":\\"allow\\"')
    expect(spec('opencode', { permissionMode: 'plan' })).toContain('\\"effect\\":\\"ask\\"')
    // opencode's ACP mode ignores the config's `model`; it is set over the
    // protocol instead.
    expect(spec('opencode', { model: 'opencode/big-pickle' })).not.toContain('big-pickle')

    // pi-acp takes neither; its model is set after the handshake.
    const pi = spec('pi')
    expect(pi).toContain('-- pi-acp')
    expect(pi.slice(0, pi.indexOf('node '))).toBe('YAAC_NO_PANE_REPORT=1 ')

    // All are embedded in a single-quoted respawn-window.
    for (const cmd of [codex, opencode, pi]) expect(cmd).not.toContain("'")
  })

  /**
   * Titles observed from live tools. claude and codex show a Braille spinner
   * (claude also the circle phases ◐◑, from 2.1.228) at the first character
   * while a turn runs. Every state waiting on the user, including a
   * permission dialog or codex's blinking "Action Required", has none. Until
   * the tool sets a title, `#{pane_title}` is the hostname. opencode and pi
   * draw their state in the pane, so tmux resolves it there and pushes a
   * verdict.
   *
   * tmux evaluates the formats itself, so they are pinned exactly: small
   * mistakes still parse but mean something else.
   * test-playwright-scripts/verify-tmux-status-format.js checks the markers
   * against a live tmux. opencode's progress strip needs 4+ cells so short
   * runs in transcript text do not match.
   */
  const HOSTNAME = 'yaac-yaac-ee9cb586-74d3-4a1f-9d1f-482839b26d70-5tfxq'
  const STATUS_CASES = {
    claude: {
      format: '#{pane_title}',
      // The whole Braille block and all four circle phases.
      running: ['⠐ Create marker', '⠋ Fix the bug', '⠀ edge', '⣿ edge', '◐ Review PR', '◑ Review PR', '◒ edge', '◓ edge'],
      // Neighbouring geometric glyphs claude uses elsewhere, and a spinner
      // anywhere but the first character.
      waiting: ['✳ Create marker', '✳ Claude Code', HOSTNAME, '', '● Ran a command', '○ Pending',
        '◆ Marker', '◔ Past the phases', '✳ Fix ⠋ rendering', '✳ Fix ◐ rendering', ' ⠋ lead', ' ◐ lead'],
    },
    codex: {
      format: '#{pane_title}',
      running: ['⠴ workdir', '⠋ yaac', '⠀ edge', '⣿ edge'],
      waiting: ['workdir', '[ ! ] Action Required workdir', '[ . ] Action Required workdir', HOSTNAME, '',
        'fix ⠋ rendering', ' ⠋ lead'],
    },
    opencode: {
      format: '#{?#{||:#{C/ri:esc\\s+(again\\s+to\\s+)?interrupt},#{C/ri:[■⬝][■⬝][■⬝][■⬝]}},running,waiting}',
      running: ['running'],
      waiting: ['waiting'],
    },
    pi: {
      format: '#{?#{||:#{C/ri:esc\\s+(to\\s+)?(interrupt|cancel|stop)},'
        + '#{C/ri:\\b(thinking|working|generating|streaming|running)\\b}},running,waiting}',
      running: [' running '],
      waiting: ['waiting'],
    },
  } as const

  // Each pane is watched in its own window's tool's terms, whatever the
  // workspace's tool (otherwise a restart would forget a codex conversation
  // in a claude workspace), and windows no agent runs in, init commands and
  // scratch shells, get no status subscription.
  it.each(Object.entries(STATUS_CASES))('watches a %s pane by its own format and classifies what it pushes', async (tool, { format, running, waiting }) => {
    const windows = [tool, `${tool}-2`, `${tool}-10`, 'shell', 'dev', `${tool}-ish`, `my${tool}`, `${tool}-`]
    const stream = new FakeTuiTmux(windows.map((w, i) => `%${String(i)}\t${w}`))
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      heartbeatIntervalMs: 60_000,
      log: () => {},
    }))
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))

    const subscriptions = stream.writes.flatMap((w) => {
      const m = /^refresh-client -B 'status-(\d+):%\d+:(.*)'\n$/.exec(w)
      return m ? [[m[1], m[2]]] : []
    })
    expect(subscriptions).toEqual([['0', format], ['1', format], ['2', format]])

    const classified = (value: string): unknown => {
      stream.feed(`%subscription-changed status-1 $0 @0 0 %1 : ${value}\n`)
      return seen.at(-1)
    }
    for (const t of running) expect(classified(t), t).toEqual({ kind: 'status', handle: '%1', status: 'running' })
    for (const t of waiting) expect(classified(t), t).toEqual({ kind: 'status', handle: '%1', status: 'waiting' })
  })

  it('observes a tui conversation through tmux control mode', async () => {
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      heartbeatIntervalMs: 60_000,
      commandTimeoutMs: 1_000,
      log: () => { /* quiet */ },
    }))

    // tmux's attach banner, then the pane listing reply.
    stream.feed('%begin 1 100 0\n%end 1 100 0\n%session-changed $0 yaac\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))
    stream.feed('%begin 1 101 1\n%7\tclaude\t0\t\n%end 1 101 1\n')
    await answer(stream, "refresh-client -B 'session-7:%7:#{=1024;s/[^ -~]//:@yaac-session}'")
    await answer(stream, "refresh-client -B 'status-7:%7:#{pane_title}'")
    // Each agent pane also subscribes to the model and permission mode its
    // tool's hooks report. tmux filters and bounds the values, since the
    // workspace can set them to anything, including newlines.
    await answer(stream,
      "refresh-client -B 'report-7:%7:#{=128;s/[^ -~]//:@yaac-model}|#{=32;s/[^A-Za-z-]//:@yaac-permission-mode}"
      + "|#{=32;s/[^a-z]//:@yaac-effort}'")

    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    // The handle is the pane id; no conversation id yet.
    expect(seen).toContainEqual({ kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude' }] })
    expect(seen.some((o) => o.kind === 'command-channel' && o.send !== null)).toBe(true)

    // Classified by the pane's own tool.
    stream.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(seen).toContainEqual({ kind: 'status', handle: '%7', status: 'running' })
    stream.feed('%subscription-changed status-7 $0 @0 0 %7 : ✳ done\n')
    expect(seen).toContainEqual({ kind: 'status', handle: '%7', status: 'waiting' })

    // A report, and then a switch, each republish the live set.
    const agentSets = (): unknown[] => seen.filter((o) => o.kind === 'live-agents')
    const before = agentSets().length
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : ||\n')
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-opus-5-5[1m]||\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', model: 'claude-opus-5-5[1m]' }],
    }))
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5||\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', model: 'claude-sonnet-5' }],
    }))
    expect(agentSets().length).toBe(before + 2)

    // The mode and effort arrive in claude's own terms; mapping the mode to
    // a posture happens elsewhere.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5|acceptEdits|xhigh\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{
        handle: '%7', tool: 'claude', model: 'claude-sonnet-5', reportedMode: 'acceptEdits', reportedEffort: 'xhigh',
      }],
    }))
    // An unchanged push is ignored; an empty part keeps the last value.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5||\n')
    expect(agentSets().length).toBe(before + 3)

    // A reply nothing asked for, and malformed notifications, change nothing.
    const count = seen.length
    stream.feed('%begin 1 900 1\nstray\n%end 1 900 1\n%subscription-changed status-7 $0\n%output nopane\n')
    expect(seen.length).toBe(count)

    // CRLF line endings are read like LF.
    stream.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ again\r\n')
    expect(seen.at(-1)).toEqual({ kind: 'status', handle: '%7', status: 'running' })

    // tmux detaching the client ends the stream; the command channel the
    // connection published then refuses.
    const channel = seen.flatMap((o) => (o.kind === 'command-channel' && o.send ? [o.send] : []))[0]
    stream.feed('%exit\n')
    expect(seen.some((o) => o.kind === 'down')).toBe(false)
    stream.emitExit()
    expect(seen.some((o) => o.kind === 'down')).toBe(true)
    await expect(channel('display-message -p ok')).rejects.toThrow('stream torn down')
  })

  // tmux's framing, fed the way a loaded pod delivers it.
  it('reads control mode however tmux frames it', async () => {
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => seen.push(o), {
      dial: () => stream, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))

    // The listing goes out before the attach banner arrives; the banner is
    // not its reply. The reply then lands split mid-line.
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))
    stream.feed('%begin 1 100 0\n%end 1 100 0\n%session-changed $0 yaac\n')
    stream.feed('%begin 1 1')
    stream.feed('01 1\n%7\tclaude\t0\t\n%end 1 101 1\n')
    await answer(stream, "refresh-client -B 'session-7:")
    await answer(stream, "refresh-client -B 'status-7:")
    await answer(stream, "refresh-client -B 'report-7:")
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    expect(seen).toContainEqual({ kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude' }] })

    // Colons inside a value are the value's.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : fix: parse a : b\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', model: 'fix: parse a : b' }],
    }))

    // An %error reply rejects with its body.
    const channel = seen.flatMap((o) => (o.kind === 'command-channel' && o.send ? [o.send] : []))[0]
    const bogus = channel('bogus-command')
    stream.feed('%begin 1 200 1\nparse error: unknown command: bogus-command\n%error 1 200 1\n')
    await expect(bogus).rejects.toThrow(/unknown command/)

    // A command still in flight when the stream ends is rejected too.
    const inFlight = channel('display-message -p ok')
    stream.feed('%exit detached\n')
    stream.emitExit()
    await expect(inFlight).rejects.toThrow('stream torn down')
    expect(seen.some((o) => o.kind === 'down')).toBe(true)
  })

  it('follows the conversation each pane names, in an agent window or a shell', async () => {
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => seen.push(o), {
      dial: () => stream, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))
    stream.feed('%begin 1 100 0\n%end 1 100 0\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))
    // An agent window and a scratch shell; the shell gets only the session
    // subscription.
    stream.feed('%begin 1 101 1\n%7\tclaude\t0\tclaude|conv-a|claude/projects/-workspace/conv-a.jsonl\n'
      + '%9\tNew Shell\t0\t\n%end 1 101 1\n')
    expect(stream.writes.join('')).toContain(
      "list-panes -s -F '#{pane_id}\t#{window_name}\t#{m/r:^\"?sleep (infinity|2147483647)\"?$,#{pane_start_command}}\t#{=1024;s/[^ -~]//:@yaac-session}' -t yaac")
    await answer(stream, "refresh-client -B 'session-7:")
    await answer(stream, "refresh-client -B 'status-7:")
    await answer(stream, "refresh-client -B 'report-7:")
    await answer(stream, "refresh-client -B 'session-9:%9:")
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    expect(stream.writes.join('')).not.toContain("'status-9:")
    const agentSets = (): unknown[] => seen.filter((o) => o.kind === 'live-agents')
    const latest = (): unknown => agentSets().at(-1)
    const push = (pane: string, value: string): void =>
      stream.feed(`%subscription-changed session-${pane} $0 @0 0 %${pane} : ${value}\n`)

    // Taken from the listing, so the first live set already names the
    // conversation.
    expect(agentSets()).toEqual([{
      kind: 'live-agents',
      agents: [{ handle: '%7', tool: 'claude', agentSessionId: 'conv-a', transcriptPath: 'claude/projects/-workspace/conv-a.jsonl' }],
    }])

    // codex started by hand in the shell also counts.
    push('9', 'codex|thread-1|codex/sessions/rollout-thread-1.jsonl')
    await vi.waitFor(() => expect(latest()).toEqual({
      kind: 'live-agents',
      agents: [
        { handle: '%7', tool: 'claude', agentSessionId: 'conv-a', transcriptPath: 'claude/projects/-workspace/conv-a.jsonl' },
        { handle: '%9', tool: 'codex', agentSessionId: 'thread-1', transcriptPath: 'codex/sessions/rollout-thread-1.jsonl' },
      ],
    }))

    // The shell's codex quit. The agent window only counts its own tool's
    // conversation, and malformed values count as none.
    push('9', '')
    push('7', 'pi|pi-1|')
    await vi.waitFor(() => expect(latest()).toEqual({ kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude' }] }))
    push('7', 'claude|conv-b|/etc/passwd')
    await vi.waitFor(() => expect(latest()).toEqual({
      kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', agentSessionId: 'conv-b' }],
    }))
    push('7', 'claude|$(rm -rf ~)|')
    await vi.waitFor(() => expect(latest()).toEqual({ kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude' }] }))
    // Ids go on a launch command line, where a leading dash is a flag.
    push('7', 'claude|conv-c|')
    push('7', 'claude|--dangerously-skip-permissions|')
    await vi.waitFor(() => expect(latest()).toEqual({ kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude' }] }))
  })

  it('waits out the placeholder a session opens on, then trusts pushes over listings', async () => {
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => seen.push(o), {
      dial: () => stream, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))
    const listings = (): number => stream.writes.join('').split('list-panes').length - 1
    const agentSets = (): unknown[] => seen.filter((o) => o.kind === 'live-agents')
    stream.feed('%begin 1 100 0\n%end 1 100 0\n')

    // The placeholder in the agent window before launch is not an agent.
    await vi.waitFor(() => expect(listings()).toBe(1))
    stream.feed('%begin 1 101 1\n%7\tclaude\t1\t\n%end 1 101 1\n')
    await answer(stream, "refresh-client -B 'boot-7:%7:#{m/r:^\"?sleep (infinity|2147483647)\"?$,#{pane_start_command}}'")
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    expect(agentSets()).toEqual([])

    // After the respawn signal the agent pane is listed again.
    stream.feed('%subscription-changed boot-7 $0 @0 0 %7 : 0\n')
    await vi.waitFor(() => expect(listings()).toBe(2))
    stream.feed('%begin 1 102 1\n%7\tclaude\t0\tclaude|conv-a|\n%end 1 102 1\n')
    await answer(stream, "refresh-client -B 'session-7:")
    await answer(stream, "refresh-client -B 'status-7:")
    await answer(stream, "refresh-client -B 'report-7:")
    await vi.waitFor(() => expect(agentSets()).toEqual([
      { kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', agentSessionId: 'conv-a' }] },
    ]))

    // A pane's push wins over a later listing, which may be older.
    stream.feed('%subscription-changed session-7 $0 @0 0 %7 : claude|conv-b|\n')
    stream.feed('%window-add @1\n')
    await vi.waitFor(() => expect(listings()).toBe(3))
    stream.feed('%begin 1 103 1\n%7\tclaude\t0\tclaude|conv-a|\n%end 1 103 1\n')
    await vi.waitFor(() => expect(agentSets()).toHaveLength(3))
    expect(agentSets().at(-1)).toEqual(
      { kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', agentSessionId: 'conv-b' }] })
  })

  it("follows a codex pane's model through its title, by the catalog codex keeps", async () => {
    // codex has no hook for a model switch, but retitles the pane. The model's
    // display name is cut from the title and mapped back to its slug via
    // codex's cached catalog.
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect({ ...session, tool: 'codex' }, (o) => seen.push(o), {
      dial: () => stream, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))
    stream.feed('%begin 1 100 0\n%end 1 100 0\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))
    stream.feed('%begin 1 101 1\n%2\tcodex\t0\t\n%end 1 101 1\n')
    await answer(stream, "refresh-client -B 'session-2:")
    await answer(stream, "refresh-client -B 'status-2:")
    await answer(stream, "refresh-client -B 'report-2:%2:#{?#{m/r: [|] ,")
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))

    // Without a cached catalog, the catalog naming rule is applied in reverse.
    stream.feed('%subscription-changed report-2 $0 @0 0 %2 : GPT-6-Astra\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%2', tool: 'codex', model: 'gpt-6-astra' }],
    }))

    // With a cache, it is checked first.
    await fs.mkdir(codexDir('demo'), { recursive: true })
    await fs.writeFile(path.join(codexDir('demo'), 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
        { slug: 'odd-slug', display_name: 'Odd Name' },
      ],
    }))
    stream.feed('%subscription-changed report-2 $0 @0 0 %2 : GPT-5.6-Sol\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%2', tool: 'codex', model: 'gpt-5.6-sol' }],
    }))
    stream.feed('%subscription-changed report-2 $0 @0 0 %2 : Odd Name\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%2', tool: 'codex', model: 'odd-slug' }],
    }))
    // An unlisted model is already titled by its slug.
    stream.feed('%subscription-changed report-2 $0 @0 0 %2 : my-made-up-model\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%2', tool: 'codex', model: 'my-made-up-model' }],
    }))
  })

  it('reports a dropped tui stream as down, and retracts the command channel', async () => {
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => seen.push(o), {
      dial: () => stream, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))
    stream.feed('%begin 1 100 0\n%end 1 100 0\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))

    stream.emitExit()
    // The watcher owns retries; the driver only reports.
    expect(seen.some((o) => o.kind === 'down')).toBe(true)
    expect(seen.at(-2)).toEqual({ kind: 'command-channel', send: null })

    // A stream that cannot be written to is down from the first command.
    const broken = new FakeStream()
    broken.stdin = { write: () => { throw new Error('EPIPE') } }
    const brokenSeen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect(session, (o) => brokenSeen.push(o), {
      dial: () => broken, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))
    await vi.waitFor(() => expect(brokenSeen).toContainEqual(
      { kind: 'down', reason: expect.stringContaining('EPIPE') as string },
    ))
  })

  it('records no conversation under an id the agent minted in the wrong shape', async () => {
    // The id ends up in file paths and launch commands.
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    const driver = agentDriver('acp')
    connections.push(driver.connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream), commandTimeoutMs: 1_000, log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: '../x; rm -rf ~' } })}\n`)

    await new Promise((r) => setTimeout(r, 100))
    expect(acpConversation('demo', 'wt-1', '../x; rm -rf ~')).toBeUndefined()
    for (const o of seen) {
      if (o.kind === 'live-agents') expect(o.agents.every((a) => a.agentSessionId === undefined)).toBe(true)
    }
  })

  it('drives an acp conversation end to end: handshake, updates, status, prompt', async () => {
    // claude's adapter reports picker values, named only in its own list.
    const modelChoices = [
      { value: 'default', name: 'Default (recommended)' },
      { value: 'opus[1m]', name: 'Opus 5.5' },
      { value: 'sonnet', name: 'Sonnet 5' },
    ]
    const stream = new FakeStream()
    tmuxWindows = 'claude\ninit\n'
    const seen: AgentObservation[] = []
    const driver = agentDriver('acp')
    connections.push(driver.connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream), commandTimeoutMs: 1_000, log: () => {},
    }))

    // Only agent windows count (`init` runs init commands).
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    // Registered under its handle, since no id exists yet.
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))

    const init = stream.sent().find((m) => m.method === 'initialize')!
    // No fs/terminal capabilities: the agent has the real files itself. No
    // `_meta` either: claude renders tool calls differently for an AIR
    // client (a read's text is dropped), so it is never told yaac is one.
    // Compactions come as their own updates.
    expect((init.params as { clientCapabilities: unknown }).clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      session: { compaction: {} },
    })
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: { sessionId: 'acp-1', configOptions: [{ id: 'model', currentValue: 'opus[1m]', options: modelChoices }] },
    })}\n`)

    // The agent's conversation id and initial model are published.
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-1', model: 'opus[1m]', modelName: 'Opus 5.5' }],
    }))

    const events = collect(acpConversation('demo', 'wt-1', 'acp-1')!)
    // Status comes from the protocol, not from a spinner.
    await driver.deliverPrompt(session, 'claude', 'hello there')
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'status', handle: 'claude', status: 'running' }))
    const prompt = stream.sent().find((m) => m.method === 'session/prompt')!
    expect(prompt.params).toEqual({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello there' }] })

    // Agent output reaches panes through acpd's log (acp-log.test.ts); the
    // conversation itself emits only turn boundaries.
    const update = (u: unknown): string =>
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: u } })}\n`
    stream.feed(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } }))
    // A `/model` switch is published as soon as the adapter reports it.
    stream.feed(update({
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'mode', currentValue: 'default' },
        { id: 'model', currentValue: 'sonnet', options: modelChoices },
      ],
    }))
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-1', model: 'sonnet', modelName: 'Sonnet 5' }],
    }))

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end']))
    expect(events[1]).toMatchObject({ stopReason: 'end_turn' })
    expect(seen.filter((o) => o.kind === 'status').at(-1)).toEqual({ kind: 'status', handle: 'claude', status: 'waiting' })
  })

  it("follows claude's own running/idle report, which covers turns the agent starts itself", async () => {
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    const driver = agentDriver('acp')
    connections.push(driver.connect(session, (o) => seen.push(o), { dial: acpDial(() => stream), log: () => {} }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    // The report is opt-in, asked for when the session opens.
    const asked = (created.params as { _meta?: { claudeCode?: { emitRawSDKMessages?: unknown[] } } })
      ._meta?.claudeCode?.emitRawSDKMessages
    expect(asked).toContainEqual({ type: 'system', subtype: 'session_state_changed' })
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'acp-1' } })}\n`)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    const events = collect(conversation)
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))

    const state = (s: string): string => `${JSON.stringify({
      jsonrpc: '2.0',
      method: '_claude/sdkMessage',
      params: { sessionId: 'acp-1', message: { type: 'system', subtype: 'session_state_changed', state: s } },
    })}\n`

    // A background task wakes the agent with no prompt of ours in flight.
    stream.feed(state('running'))
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting', 'running']))
    expect(conversation.isBusy).toBe(true)
    // A message steers into it, as into any running turn.
    await driver.deliverPrompt(session, 'claude', 'also this')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === '_session/steering')).toBe(true))
    const steer = stream.sent().find((m) => m.method === '_session/steering')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: steer.id, result: { outcome: 'injected' } })}\n`)
    // Stop reaches it too, and ends it without waiting for the idle report.
    conversation.cancel()
    expect(stream.sent().some((m) => m.method === 'session/cancel')).toBe(true)
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting', 'running', 'waiting']))
    stream.feed(state('idle'))
    await new Promise((r) => setTimeout(r, 20))
    expect(statuses(seen)).toEqual(['waiting', 'running', 'waiting'])
    expect(events).toEqual([{ type: 'turn-start' }, { type: 'turn-end', stopReason: 'end_turn' }])

    // Our prompt's reply comes before the adapter goes idle (it waits out
    // background agents), so the turn ends at idle, with the reply's reason.
    await driver.deliverPrompt(session, 'claude', 'next')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))
    const prompt = stream.sent().find((m) => m.method === 'session/prompt')!
    stream.feed(state('running'))
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'max_tokens' } })}\n`)
    await new Promise((r) => setTimeout(r, 20))
    expect(statuses(seen).at(-1)).toBe('running')
    stream.feed(state('idle'))
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('waiting'))
    expect(events.slice(2)).toEqual([{ type: 'turn-start' }, { type: 'turn-end', stopReason: 'max_tokens' }])

    // The CLI under the adapter dies mid-run: no idle report ever comes, and
    // the adapter refuses what is sent next. That refusal ends the run.
    stream.feed(state('running'))
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('running'))
    await driver.deliverPrompt(session, 'claude', 'still there?')
    await vi.waitFor(() => expect(stream.sent().filter((m) => m.method === '_session/steering')).toHaveLength(2))
    const deadSteer = stream.sent().filter((m) => m.method === '_session/steering')[1]
    const refusal = { code: -32603, message: 'the session has ended' }
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: deadSteer.id, error: refusal })}\n`)
    await vi.waitFor(() => expect(stream.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(2))
    const deadPrompt = stream.sent().filter((m) => m.method === 'session/prompt')[1]
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: deadPrompt.id, error: refusal })}\n`)
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('waiting'))
    expect(conversation.isBusy).toBe(false)
  })

  it("recovers an agent-started turn from claude's report in the record", async () => {
    await record('acp-live', [
      lifeLine,
      {
        jsonrpc: '2.0',
        method: '_claude/sdkMessage',
        params: { sessionId: 'acp-live', message: { type: 'system', subtype: 'session_state_changed', state: 'running' } },
      },
    ])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    const events = collect(acpConversation('demo', 'wt-1', 'acp-live')!)
    stream.feed(helloLine(false))
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['running']))
    expect(events.map((e) => e.type)).toEqual(['turn-start'])

    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      method: '_claude/sdkMessage',
      params: { sessionId: 'acp-live', message: { type: 'system', subtype: 'session_state_changed', state: 'idle' } },
    })}\n`)
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['running', 'waiting']))
    expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end'])
  })

  it("reads claude's live background work between turns as background, not waiting", async () => {
    const sdk = (message: Record<string, unknown>): Record<string, unknown> => ({
      jsonrpc: '2.0',
      method: '_claude/sdkMessage',
      params: { sessionId: 'acp-bg', message: { type: 'system', ...message } },
    })
    const state = (s: string): Record<string, unknown> => sdk({ subtype: 'session_state_changed', state: s })
    const tasks = (...list: Array<Record<string, unknown>>): Record<string, unknown> =>
      sdk({ subtype: 'background_tasks_changed', tasks: list })
    const shell = { task_id: 'b1', task_type: 'local_bash', description: 'sleep 60' }
    const feed = (stream: FakeStream, msg: Record<string, unknown>): void => stream.feed(`${JSON.stringify(msg)}\n`)
    // The turn ended with a background shell still going: recovered from the
    // record on a reattach.
    await record('acp-bg', [lifeLine, state('running'), tasks(shell), state('idle')])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-bg' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-bg')).toBeDefined())
    stream.feed(helloLine(false))
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['background']))

    // The shell finishing is reported just before its notification wakes the
    // agent, which goes straight to running with no waiting spell between.
    feed(stream, tasks())
    feed(stream, state('running'))
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['background', 'running']))
    feed(stream, state('idle'))
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['background', 'running', 'waiting']))

    // An ambient watch is not the agent's work.
    feed(stream, tasks({ task_id: 'w1', task_type: 'local_bash', description: 'artifact', ambient: true }))
    feed(stream, tasks({ task_id: 'w1', ambient: true }, shell))
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('background'))
    expect(statuses(seen)).toHaveLength(4)

    // Work that ends without waking the agent settles to waiting.
    vi.useFakeTimers()
    try {
      feed(stream, tasks())
      await vi.advanceTimersByTimeAsync(1000)
      expect(statuses(seen).at(-1)).toBe('background')
      await vi.advanceTimersByTimeAsync(3000)
      expect(statuses(seen).at(-1)).toBe('waiting')
    } finally {
      vi.useRealTimers()
    }
  })

  it('declares each adapter its own opt-ins for reporting subagents and background work', async () => {
    const streams = new Map([['codex', new FakeStream()], ['opencode', new FakeStream()]])
    tmuxWindows = 'codex\nopencode\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial((_s, argv) => streams.get([...streams.keys()].find((h) => argv.join(' ').includes(`/${h}.sock`))!)!),
      log: () => {},
    }))
    const capabilities = async (handle: string): Promise<unknown> => {
      const stream = streams.get(handle)!
      await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', handle)).toBeDefined())
      stream.feed(helloLine(true))
      await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
      return (stream.sent().find((m) => m.method === 'initialize')!.params as { clientCapabilities: unknown })
        .clientCapabilities
    }
    expect(await capabilities('codex')).toMatchObject({
      _meta: {
        jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } },
        terminal_output_delta: true,
      },
    })
    expect(await capabilities('opencode')).toMatchObject({ _meta: { 'opencode/child-session-updates': true } })
  })

  it("follows codex's and pi's own state reports", async () => {
    const streams = new Map([['codex', new FakeStream()], ['pi', new FakeStream()]])
    tmuxWindows = 'codex\npi\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial((_s, argv) => streams.get([...streams.keys()].find((h) => argv.join(' ').includes(`/${h}.sock`))!)!),
      recordedSessions: () => Promise.resolve([
        { handle: 'codex', agentSessionId: 'acp-codex' },
        { handle: 'pi', agentSessionId: 'acp-pi' },
      ]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-pi')).toBeDefined())
    const of = (handle: string): string[] =>
      seen.flatMap((o) => (o.kind === 'status' && o.handle === handle ? [o.status] : []))
    const codex = streams.get('codex')!
    const pi = streams.get('pi')!
    codex.feed(helloLine(false))
    pi.feed(helloLine(false))
    await vi.waitFor(() => expect([of('codex').at(-1), of('pi').at(-1)]).toEqual(['waiting', 'waiting']))

    // A goal continuation: codex brackets it with its thread status.
    const threadStatus = (type: string): string =>
      updateLine('acp-codex', { sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type } } } })
    codex.feed(threadStatus('active'))
    await vi.waitFor(() => expect(of('codex').at(-1)).toBe('running'))
    codex.feed(threadStatus('idle'))
    await vi.waitFor(() => expect(of('codex').at(-1)).toBe('waiting'))

    // pi-acp reports a run an extension starts, and its settle.
    const piRunning = (running: boolean): string =>
      updateLine('acp-pi', { sessionUpdate: 'session_info_update', _meta: { piAcp: { queueDepth: 0, running } } })
    pi.feed(piRunning(true))
    await vi.waitFor(() => expect(of('pi').at(-1)).toBe('running'))
    pi.feed(piRunning(false))
    await vi.waitFor(() => expect(of('pi').at(-1)).toBe('waiting'))
  })

  it('resumes a recorded acp conversation with session/load instead of a new one', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-old' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { agentCapabilities: { loadSession: true } } })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/load')).toBe(true))
    const load = stream.sent().find((m) => m.method === 'session/load')!
    expect(load.params).toMatchObject({ sessionId: 'acp-old', cwd: '/workspace' })
    expect(stream.sent().some((m) => m.method === 'session/new')).toBe(false)

    // The reply's model (in the `models` shape) is published.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: load.id, result: { models: { currentModelId: 'claude-fable-5' } } })}\n`)
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-old', model: 'claude-fable-5' }],
    }))
  })

  it('skips the handshake when reattaching to an agent that is already running', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    // Already initialized, so `initialize` is not sent again.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    await new Promise((r) => setTimeout(r, 50))
    expect(stream.sent().some((m) => m.method === 'initialize')).toBe(false)
    expect(stream.sent().some((m) => m.method === 'session/new')).toBe(false)
  })

  // The old server went down before its posture call landed, so the session
  // is in the adapter's default. The next
  // connection makes the call, without reporting that default for the row to
  // follow. Once a call has landed, a reattach leaves the session's mode
  // alone, since the user may have moved it since.
  it('finishes the posture a dropped connection\'s handshake never set, and only then', async () => {
    // As seen live: the old server's effort call was answered after it went.
    await record('acp-short', [
      ...handshakeOnly('acp-short', 'default'),
      { jsonrpc: '2.0', id: 'h-2', method: 'session/set_config_option', params: { sessionId: 'acp-short', configId: 'effort', value: 'medium' } },
      { jsonrpc: '2.0', id: 'h-2', result: { configOptions: [] } },
    ])
    const short = await attachedUnder('bypass', 'acp-short')
    await vi.waitFor(() => expect(short.stream.sent().some((m) => m.method === 'session/set_mode')).toBe(true))
    const setMode = short.stream.sent().find((m) => m.method === 'session/set_mode')!
    expect(setMode.params).toEqual({ sessionId: 'acp-short', modeId: 'bypassPermissions' })
    // The default it was left in is no choice, so the row is not moved to it.
    expect(reportedModes(short.seen)).not.toContain('default')
    // Not ready until the posture lands, so a held prompt's turn runs in it.
    const conversation = acpConversation('demo', 'wt-1', 'acp-short')!
    await expect(conversation.whenReady(100)).rejects.toThrow()
    short.stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: setMode.id, result: {} })}\n`)
    await conversation.whenReady(5_000)

    // A posture that is the adapter's default needs no call, so its launch
    // looks unsettled until the first prompt. Its reattach sends nothing and
    // still reports the mode, which is the posture's.
    await record('acp-manual', handshakeOnly('acp-manual', 'default'))
    const manual = await attachedUnder('manual', 'acp-manual')
    await vi.waitFor(() => expect(reportedModes(manual.seen).at(-1)).toBe('default'))
    expect(manual.stream.sent().some((m) => typeof m.method === 'string' && m.method.startsWith('session/'))).toBe(false)

    await recordMode('acp-settled', 'acceptEdits')
    const settled = await attachedUnder('bypass', 'acp-settled')
    await vi.waitFor(() => expect(reportedModes(settled.seen).at(-1)).toBe('acceptEdits'))
    await new Promise((r) => setTimeout(r, 50))
    expect(settled.stream.sent().some((m) => m.method === 'session/set_mode')).toBe(false)
  })

  it('recovers a turn the previous connection started, and ends it on the orphan reply', async () => {
    // A reattach can land mid-turn. ACP cannot report that, since this
    // connection sent no prompt, so the log (which has both directions) is used.
    await record('acp-live', [
      lifeLine,
      promptLine('acp-live', 'old-1', 'refactor the thing'),
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } },
        },
      },
    ])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-live')!
    // Subscribed before hello, like a pane that stayed open across the drop.
    const events = collect(conversation)

    stream.feed(helloLine(false))

    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'status', handle: 'claude', status: 'running',
    }))
    // No guessed `waiting` status before the log was read.
    expect(statuses(seen)).toEqual(['running'])
    // The pane sent no prompt for this turn, so `turn-start` is announced.
    expect(events.map((e) => e.type)).toEqual(['turn-start'])

    // The recovered turn can be cancelled.
    conversation.cancel()
    expect(stream.sent().some((m) => m.method === 'session/cancel')).toBe(true)

    // The reply to the old connection's request ends the recovered turn.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'status', handle: 'claude', status: 'waiting',
    }))
    expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end'])
  })

  it('classifies a reattach as waiting when the record shows the turn was answered', async () => {
    // The reply arrived while nothing was attached, so only the log shows it.
    await record('acp-done', [
      lifeLine,
      promptLine('acp-done', 'old-1', 'what changed?'),
      { jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } },
    ])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-done' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-done')).toBeDefined())
    stream.feed(helloLine(false))

    // Still published, so the sidebar can show it.
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))
  })

  it('reads a turn whose agent died as ended, not as still running', async () => {
    // acpd's exit line ends an unanswered turn.
    await record('acp-dead', [
      lifeLine,
      promptLine('acp-dead', 'old-1', 'do the thing'),
      { jsonrpc: '2.0', method: '_acpd/exit', params: { code: 1, signal: null } },
    ])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-dead' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-dead')).toBeDefined())
    stream.feed(helloLine(false))

    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))
  })

  it('steers a prompt sent straight after a reattach into the turn it recovered, or holds it behind', async () => {
    // A new `session/prompt` now would overlap two turns, and the first reply
    // would end the wrong one. claude's adapter takes it as a steer instead.
    await record('acp-live', [lifeLine, promptLine('acp-live', 'old-1', 'the running turn')])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-live')!
    stream.feed(helloLine(false))
    await vi.waitFor(() => expect(conversation.isBusy).toBe(true))

    void conversation.prompt('and now this').catch(() => {})
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === '_session/steering')).toBe(true))
    // The agent says that turn is over (its reply is still on the way), so
    // the message waits for it rather than overlapping.
    const steer = stream.sent().find((m) => m.method === '_session/steering')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: steer.id, result: { outcome: 'promptRequired' } })}\n`)
    await new Promise((r) => setTimeout(r, 50))
    expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(false)

    // The old reply ends the recovered turn and releases the queue.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))
    expect((stream.sent().find((m) => m.method === 'session/prompt')!
      .params as { prompt: Array<{ text: string }> }).prompt[0].text).toBe('and now this')
  })

  it('lets a reply that beats the record scan settle the status, rather than stranding it busy', async () => {
    // Anything that settles the status before the log is read is newer than
    // the log, so the scan must not overwrite it.
    await record('acp-live', [lifeLine, promptLine('acp-live', 'old-1', 'go')])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())

    stream.feed(helloLine(false))
    // Same tick as hello, so the log scan has not finished.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } })}\n`)

    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))
    // Long enough for the scan to come back and be ignored.
    await new Promise((r) => setTimeout(r, 50))
    expect(statuses(seen)).toEqual(['waiting'])
  })

  it('grants tool permission rather than prompting under bypass, matching the sandbox posture', async () => {
    await recordMode('acp-1', 'bypassPermissions')
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      // A reattach needs the recorded id (without one, see below).
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    stream.feed(permissionAsk(99))

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 99)).toBe(true))
    // allow_always over allow_once: the sandbox is the real constraint.
    expect(stream.sent().find((m) => m.id === 99)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
  })

  /**
   * The ask is held open, the conversation reports `waiting`, and the user's
   * answer is what reaches the agent.
   */
  it('parks a permission ask for the user under a posture that is not bypass', async () => {
    const { stream, seen } = await attachedUnder('accept-edits', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!

    stream.feed(permissionAsk(99))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 99)).toBe(false)

    // Busy at the protocol level, but shown as asking the user everywhere.
    await vi.waitFor(() => expect(conversation.status).toBe('asking'))
    expect(statuses(seen).at(-1)).toBe('asking')

    conversation.answerPermission('99', 'no')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 99)).toBe(true))
    expect(stream.sent().find((m) => m.id === 99)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  /** A `session/update` notification, as a wire line. */
  const updateLine = (agentSessionId: string, update: Record<string, unknown>): string =>
    `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: agentSessionId, update } })}\n`

  /** Every mode the connection published on its live set, in order. */
  const reportedModes = (seen: AgentObservation[]): string[] => seen.flatMap((o) =>
    o.kind === 'live-agents' ? o.agents.flatMap((a) => (a.reportedMode !== undefined ? [a.reportedMode] : [])) : [])

  /**
   * An adapter can change mode itself (claude reports entering or leaving
   * plan mode as `current_mode_update`). Asks are then answered by the new
   * mode, and it is reported upward.
   */
  it('publishes a mode the adapter moves to, and answers its asks by it', async () => {
    const { stream, seen } = await attachedUnder('bypass', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!

    stream.feed(updateLine('acp-1', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }))
    await vi.waitFor(() => expect(reportedModes(seen).at(-1)).toBe('plan'))

    // The row says bypass, but the session is now in plan mode.
    stream.feed(permissionAsk(99))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 99)).toBe(false)
  })

  // A plan-exit ask's options are mode ids, so answering one can loosen the
  // session's mode.
  it('follows a mode the adapter moves up to, as well as down', async () => {
    const { stream, seen } = await attachedUnder('plan', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-1',
        toolCall: { toolCallId: 'call-5', title: 'Ready to code?', kind: 'switch_mode' },
        options: [
          { optionId: 'bypassPermissions', name: 'Yes, and bypass permissions', kind: 'allow_always' },
          { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
        ],
      },
    })}\n`)
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    conversation.answerPermission('5', 'bypassPermissions')
    stream.feed(updateLine('acp-1', { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' }))
    await vi.waitFor(() => expect(reportedModes(seen).at(-1)).toBe('bypassPermissions'))

    stream.feed(permissionAsk(6))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 6)).toBe(true))
  })

  // A reattach runs no handshake, so it takes the mode from the log (which
  // may have changed while no server was attached) and reports it.
  it('answers a reattach by the mode its own record shows, and reports it', async () => {
    await recordMode('acp-1', 'default')
    await record('acp-2', [
      lifeLine,
      { jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'acp-2', update: { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' },
      } },
    ])
    const lowered = await attachedUnder('bypass', 'acp-1')
    await vi.waitFor(() => expect(reportedModes(lowered.seen).at(-1)).toBe('default'))
    lowered.stream.feed(permissionAsk(7))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')!.isAwaitingPermission).toBe(true))
    expect(lowered.stream.sent().some((m) => m.id === 7)).toBe(false)

    const raised = await attachedUnder('manual', 'acp-2')
    await vi.waitFor(() => expect(reportedModes(raised.seen).at(-1)).toBe('bypassPermissions'))
    raised.stream.feed(permissionAsk(8))
    await vi.waitFor(() => expect(raised.stream.sent().some((m) => m.id === 8)).toBe(true))

    // A mode that maps to no posture: every ask goes to the user. The row is
    // not used, since another conversation may have changed it.
    await recordMode('acp-3', 'build')
    const unknown = await attachedUnder('bypass', 'acp-3')
    unknown.stream.feed(permissionAsk(9))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-3')!.isAwaitingPermission).toBe(true))
    expect(unknown.stream.sent().some((m) => m.id === 9)).toBe(false)
  })

  // opencode's modes are agents, not postures, so it keeps the posture it
  // launched with, even if another conversation later changes the row.
  it('answers by the posture it launched in where its mode names none', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'opencode\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('accept-edits'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'opencode')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: { sessionId: 'acp-oc', configOptions: [{ id: 'mode', currentValue: 'build' }] },
    })}\n`)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-oc')?.status).toBe('waiting'))

    // Another conversation raises the workspace's posture.
    setAcpPermissionMode('demo', 'wt-1', 'bypass')
    stream.feed(permissionAsk(4))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-oc')!.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 4)).toBe(false)
  })

  it('reads a mode change reported as a config option, which is how codex-acp says it', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'codex\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'codex', agentSessionId: 'acp-1' }]),
      permissionMode: () => Promise.resolve('accept-edits'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(helloLine(false))
    stream.feed(updateLine('acp-1', {
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'mode', currentValue: 'agent-full-access' },
        { id: 'model', currentValue: 'gpt-5.2-codex' },
      ],
    }))
    await vi.waitFor(() => expect(reportedModes(seen).at(-1)).toBe('agent-full-access'))
  })

  /** Each conversation answers asks by its own adapter's mode. */
  it('keeps each conversation on its own posture', async () => {
    await recordMode('acp-a', 'bypassPermissions')
    await recordMode('acp-b', 'bypassPermissions')
    const streams = new Map([['claude', new FakeStream()], ['claude-2', new FakeStream()]])
    tmuxWindows = 'claude\nclaude-2\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial((_s, argv) => streams.get([...streams.keys()].find((h) => argv.join(' ').includes(`${h}.sock`))!)!),
      recordedSessions: () => Promise.resolve([
        { handle: 'claude', agentSessionId: 'acp-a' },
        { handle: 'claude-2', agentSessionId: 'acp-b' },
      ]),
      permissionMode: () => Promise.resolve('bypass'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-b')).toBeDefined())
    const a = streams.get('claude')!
    const b = streams.get('claude-2')!
    a.feed(helloLine(false))
    b.feed(helloLine(false))

    a.feed(updateLine('acp-a', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }))
    a.feed(permissionAsk(1))
    b.feed(permissionAsk(2))
    // The other conversation still bypasses, so its ask is auto-answered.
    await vi.waitFor(() => expect(b.sent().some((m) => m.id === 2)).toBe(true))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-a')!.isAwaitingPermission).toBe(true))
    expect(a.sent().some((m) => m.id === 1)).toBe(false)
  })

  it('answers a dismissal as cancelled, and ignores a second answer for the same ask', async () => {
    const { stream } = await attachedUnder('manual', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!

    stream.feed(permissionAsk(7))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))

    conversation.answerPermission('7')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 7)).toBe(true))
    expect(stream.sent().find((m) => m.id === 7)!.result)
      .toEqual({ outcome: { outcome: 'cancelled' } })

    // A second pane's answer to the same ask is ignored.
    conversation.answerPermission('7', 'yes-always')
    await new Promise((r) => setTimeout(r, 20))
    expect(stream.sent().filter((m) => m.id === 7)).toHaveLength(1)
  })

  it('releases a parked ask when the turn is cancelled, rather than stranding the promise', async () => {
    const { stream } = await attachedUnder('manual', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    void conversation.prompt('go').catch(() => {})
    await vi.waitFor(() => expect(conversation.isBusy).toBe(true))
    stream.feed(permissionAsk(11))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))

    conversation.cancel()

    // ACP requires the client to resolve outstanding asks on cancel.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 11)).toBe(true))
    expect(stream.sent().find((m) => m.id === 11)!.result)
      .toEqual({ outcome: { outcome: 'cancelled' } })
    expect(stream.sent().some((m) => m.method === 'session/cancel')).toBe(true)
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  it('answers an ask that arrived before a reconnect, rather than stranding the agent', async () => {
    // acpd does not replay asks, so this one is recovered from the log and
    // answered by the agent's own id.
    await record('acp-held', [
      lifeLine,
      promptLine('acp-held', 'old-1', 'do the thing'),
      { jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: askParams },
    ])
    const { stream, seen } = await attachedUnder('manual', 'acp-held')
    const conversation = acpConversation('demo', 'wt-1', 'acp-held')!

    // Recovered from the log.
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('asking'))

    conversation.answerPermission('42', 'yes-always')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 42)).toBe(true))
    expect(stream.sent().find((m) => m.id === 42)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  it('lands an answer clicked before recovery knew which ask it was for', async () => {
    // A pane can show the pending ask (from the log) before the conversation
    // has recovered it. An answer in that window must still be delivered.
    await record('acp-held', [
      lifeLine,
      promptLine('acp-held', 'old-1', 'do the thing'),
      { jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: askParams },
    ])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-held' }]),
      permissionMode: () => Promise.resolve('manual'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-held')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-held')!

    // Answered before hello starts recovery.
    conversation.answerPermission('42', 'yes-always')
    stream.feed(helloLine(false))

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 42)).toBe(true))
    expect(stream.sent().find((m) => m.id === 42)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  it('forwards an ask when the posture could not be read, rather than granting it', async () => {
    // A needless prompt costs a click; a wrong approval cannot be undone. So
    // an unknown posture never auto-answers.
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      permissionMode: () => Promise.reject(new Error('database is down')),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    stream.feed(helloLine(false))

    stream.feed(permissionAsk(99))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(stream.sent().some((m) => m.id === 99)).toBe(false)
  })

  it('tells the adapter its posture on a first attach, and leaves a live one alone', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('plan'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(helloLine(true))

    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: {
        sessionId: 'acp-1',
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default' }, { id: 'plan' }, { id: 'acceptEdits' }],
        },
      },
    })}\n`)

    // The mode decides which asks happen at all, so it must be sent.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(true))
    expect(stream.sent().find((m) => m.method === 'session/set_mode')!.params)
      .toEqual({ sessionId: 'acp-1', modeId: 'plan' })
  })

  it('reads an adapter that announces its modes as config options, not a modes block', async () => {
    // opencode v2 offers modes only as a `mode` config option (values are
    // agent ids), with no `modes` block. Missing it would leave a `plan`
    // workspace in `build`, able to edit.
    const stream = new FakeStream()
    tmuxWindows = 'opencode\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('plan'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'opencode')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: {
        sessionId: 'ses_1',
        configOptions: [
          { id: 'model', currentValue: 'opencode/big-pickle' },
          {
            id: 'mode',
            currentValue: 'build',
            options: [{ value: 'build' }, { value: 'plan' }],
          },
        ],
      },
    })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(true))
    expect(stream.sent().find((m) => m.method === 'session/set_mode')!.params)
      .toEqual({ sessionId: 'ses_1', modeId: 'plan' })
  })

  it('leaves a mode alone when the adapter is already in it', async () => {
    // A missing `session/set_mode` then does not mean a posture was dropped.
    const stream = new FakeStream()
    tmuxWindows = 'opencode\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('plan'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'opencode')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: {
        sessionId: 'ses_1',
        configOptions: [
          { id: 'mode', currentValue: 'plan', options: [{ value: 'build' }, { value: 'plan' }] },
        ],
      },
    })}\n`)

    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'ses_1')).toBeDefined())
    await new Promise((r) => setTimeout(r, 20))
    expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(false)
  })

  it('names the model over the protocol for an adapter that takes it no other way', async () => {
    // pi's adapter has no `--model`, and the model decides the provider (and
    // so which api key the proxy injects).
    const stream = new FakeStream()
    tmuxWindows = 'pi\n'
    // The workspace's recorded model, read for the tool once the session
    // is new.
    const asked: string[] = []
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('bypass'),
      launchModel: (tool) => {
        asked.push(tool)
        return Promise.resolve(acpLaunchModel({ tool }))
      },
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'pi')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'pi-1' } })}\n`)

    // Via the `model` config option; pi-acp does not implement `session/set_model`.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(true))
    const setModel = stream.sent().find((m) => m.method === 'session/set_config_option')!
    expect(setModel.params).toEqual({ sessionId: 'pi-1', configId: 'model', value: PI_DEFAULT_MODEL })
    expect(asked).toEqual(['pi'])
    expect(stream.sent().some((m) => m.method === 'session/set_model')).toBe(false)
    // pi's modes are thinking levels, so no mode is set.
    expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(false)

    // A rejected model is reported to the pane: pi's default model may use a
    // provider whose key the proxy does not inject.
    const events: AcpEventInit[] = []
    acpConversationByHandle('demo', 'wt-1', 'pi')!.subscribe((e) => events.push(e))
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: setModel.id, error: { code: -32602, message: 'unknown model' },
    })}\n`)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    expect((events.find((e) => e.type === 'error') as { message: string }).message)
      .toContain(PI_DEFAULT_MODEL)
  })

  // On a slow start opencode answers `session/new` before its model catalog
  // has loaded, offering only its built-in provider, and refuses any other
  // model until the catalog arrives as a `config_option_update`.
  it('names the launch model once the session offers it', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'opencode\n'
    const target = 'openrouter/deepseek/deepseek-v4.1-flash'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('bypass'),
      launchModel: () => Promise.resolve(target),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'opencode')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    const modelOption = (values: string[]): Record<string, unknown> => ({
      id: 'model', currentValue: 'opencode/big-pickle', options: values.map((value) => ({ value })),
    })
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: created.id, result: { sessionId: 'ses_1', configOptions: [modelOption(['opencode/big-pickle'])] },
    })}\n`)

    await new Promise((r) => setTimeout(r, 20))
    expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(false)
    stream.feed(updateLine('ses_1', {
      sessionUpdate: 'config_option_update', configOptions: [modelOption(['opencode/big-pickle', target])],
    }))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(true))
    expect(stream.sent().find((m) => m.method === 'session/set_config_option')!.params)
      .toEqual({ sessionId: 'ses_1', configId: 'model', value: target })
  })

  // A model the session never offers is asked for anyway once the wait runs
  // out, so the handshake still finishes and the refusal reaches the pane.
  it('names a launch model the session never offers after the wait, and reports the refusal', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'opencode\n'
    const target = 'openrouter/retired/model'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('bypass'),
      launchModel: () => Promise.resolve(target),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'opencode')).toBeDefined())
    const events: AcpEventInit[] = []
    acpConversationByHandle('demo', 'wt-1', 'opencode')!.subscribe((e) => events.push(e))
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    const modelOption = (values: string[]): Record<string, unknown> => ({
      id: 'model', currentValue: 'opencode/big-pickle', options: values.map((value) => ({ value })),
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      stream.feed(`${JSON.stringify({
        jsonrpc: '2.0', id: created.id, result: { sessionId: 'ses_1', configOptions: [modelOption(['opencode/big-pickle'])] },
      })}\n`)
      stream.feed(updateLine('ses_1', {
        sessionUpdate: 'config_option_update',
        configOptions: [modelOption(['opencode/big-pickle', 'openrouter/deepseek/deepseek-v4.1-flash'])],
      }))
      await vi.advanceTimersByTimeAsync(9_000)
      expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(true))
    const setModel = stream.sent().find((m) => m.method === 'session/set_config_option')!
    expect(setModel.params).toEqual({ sessionId: 'ses_1', configId: 'model', value: target })
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: setModel.id, error: { code: -32602, message: `model not found: ${target}` },
    })}\n`)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    expect((events.find((e) => e.type === 'error') as { message: string }).message)
      .toContain(`would not switch to the model "${target}"`)
  })

  /** pi-acp's thinking-level option at `current` (docs/effort-levels.md). */
  const thoughtLevel = (current: string): Record<string, unknown> => ({
    id: 'thought_level',
    category: 'thought_level',
    type: 'select',
    currentValue: current,
    options: [{ value: 'low', name: 'Thinking: low' }, { value: 'high', name: 'Thinking: high' }],
  })
  /** Every effort the connection published on its live set, in order. */
  const reportedEfforts = (seen: AgentObservation[]): string[] => seen.flatMap((o) =>
    o.kind === 'live-agents' ? o.agents.flatMap((a) => (a.reportedEffort !== undefined ? [a.reportedEffort] : [])) : [])

  // A new conversation is put at the workspace's effort, since its adapter
  // would otherwise read what another workspace saved to the shared home.
  // The effort is read when the handshake starts, so a level recorded after
  // connect (a spare's claim) is the one used. Every level the conversation
  // then reports goes upward for the row to follow, and the pane is offered
  // the adapter's own list.
  it("puts a conversation at the workspace's effort and follows each level it reports", async () => {
    const stream = new FakeStream()
    tmuxWindows = 'pi\n'
    const seen: AgentObservation[] = []
    let effort = 'low'
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('bypass'),
      effort: () => Promise.resolve(effort),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'pi')).toBeDefined())
    effort = 'high'
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: created.id, result: { sessionId: 'pi-1', configOptions: [thoughtLevel('low')] },
    })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(true))
    const setEffort = stream.sent().find((m) => m.method === 'session/set_config_option')!
    expect(setEffort.params).toEqual({ sessionId: 'pi-1', configId: 'thought_level', value: 'high' })
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: setEffort.id, result: { configOptions: [thoughtLevel('high')] } })}\n`)
    const conversation = acpConversationByHandle('demo', 'wt-1', 'pi')!
    await vi.waitFor(() => expect(conversation.efforts).toEqual({
      current: 'high',
      available: [{ value: 'low', name: 'Thinking: low' }, { value: 'high', name: 'Thinking: high' }],
    }))

    // The user moves it in the agent's own UI; the update is the report.
    stream.feed(updateLine('pi-1', { sessionUpdate: 'config_option_update', configOptions: [thoughtLevel('low')] }))
    // The adapter's starting level is never reported: the row would be left
    // there if the connection dropped before the launch's call landed.
    await vi.waitFor(() => expect(reportedEfforts(seen)).toEqual(['high', 'low']))
  })

  // A reattach runs no handshake, so the session's state comes from the
  // record, as the user last left it: the levels and modes a pane may pick,
  // and the model, reported upward so the row (and a restart) follows a
  // switch made while no server was attached.
  it("reads a reattached conversation's effort, modes and model back from its record", async () => {
    await record('acp-1', [
      lifeLine,
      { jsonrpc: '2.0', id: 'h-1', method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } },
      { jsonrpc: '2.0', id: 'h-1', result: {
        sessionId: 'acp-1',
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'acceptEdits' }, { id: 'plan' }] },
        models: { currentModelId: 'opus', availableModels: [{ modelId: 'opus' }, { modelId: 'sonnet' }] },
        configOptions: [thoughtLevel('low')],
      } },
      { jsonrpc: '2.0', id: 'h-2', result: { configOptions: [thoughtLevel('high')] } },
      // A switch whose reply names no model, then one the agent refused.
      { jsonrpc: '2.0', id: 'm-1', method: 'session/set_config_option', params: { sessionId: 'acp-1', configId: 'model', value: 'sonnet' } },
      { jsonrpc: '2.0', id: 'm-1', result: {} },
      { jsonrpc: '2.0', id: 'm-2', method: 'session/set_config_option', params: { sessionId: 'acp-1', configId: 'model', value: 'haiku' } },
      { jsonrpc: '2.0', id: 'm-2', error: { code: -32602, message: 'unknown model' } },
      // Its launch is long settled.
      promptLine('acp-1', 'p-1', 'hi'),
      { jsonrpc: '2.0', id: 'p-1', result: { stopReason: 'end_turn' } },
    ])
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      permissionMode: () => Promise.resolve('manual'),
      effort: () => Promise.resolve('low'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(helloLine(false))
    const conversation = acpConversationByHandle('demo', 'wt-1', 'claude')!
    await vi.waitFor(() => expect(conversation.efforts.current).toBe('high'))
    expect(conversation.permissionModes).toEqual({ current: 'manual', available: ['accept-edits', 'manual', 'plan'] })
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [expect.objectContaining({ handle: 'claude', model: 'sonnet', reportedMode: 'default', reportedEffort: 'high' })],
    }))
    // Nothing is re-sent to a live adapter.
    expect(stream.sent().some((m) => typeof m.method === 'string' && m.method.startsWith('session/'))).toBe(false)
  })

  it('forwards an adapter question under bypass when the adapter has no permissions to waive', async () => {
    // pi has no permission system; its permission requests are extension
    // questions the user must answer.
    const stream = new FakeStream()
    tmuxWindows = 'pi\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('bypass'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'pi')).toBeDefined())
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'pi-1' } })}\n`)

    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 501,
      method: 'session/request_permission',
      params: { options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] },
    })}\n`)
    // Held open for the user.
    await vi.waitFor(() => expect(
      acpConversationByHandle('demo', 'wt-1', 'pi')!.status,
    ).toBe('asking'))
    expect(stream.sent().some((m) => m.id === 501)).toBe(false)
  })

  it('reports a mode it could not set to the pane, and keeps the conversation', async () => {
    // An adapter may refuse a mode (e.g. `bypassPermissions` as root outside a
    // sandbox). The conversation continues in the adapter's default, but the
    // pane is told, since that default may be looser than what was asked.
    const stream = new FakeStream()
    const events: AcpEventInit[] = []
    const seen: AgentObservation[] = []
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('bypass'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    // Subscribe before the handshake, which makes the report.
    acpConversationByHandle('demo', 'wt-1', 'claude')!.subscribe((e) => events.push(e))
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: { sessionId: 'acp-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] } },
    })}\n`)

    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    await new Promise((r) => setTimeout(r, 20))
    expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(false)

    // The message names the actual mode and promises nothing about asks.
    const reported = events.filter((e) => e.type === 'error')
    expect(reported.length).toBe(1)
    expect((reported[0] as { message: string }).message).toContain('bypassPermissions')
    expect((reported[0] as { message: string }).message).toContain('default')
    expect((reported[0] as { message: string }).message).not.toContain('forwarded')

    // The actual mode is reported and used; `default` asks the user.
    await vi.waitFor(() => expect(reportedModes(seen).at(-1)).toBe('default'))
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    stream.feed(permissionAsk(3))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 3)).toBe(false)
  })

  it('steps down from a refused mode rather than run looser, and reports it', async () => {
    // codex-acp's default `agent` mode is looser than `accept-edits`, so a
    // refused `session/set_mode` moves the session to the most permissive
    // mode no looser than asked, and the pane is told.
    const stream = new FakeStream()
    const events: AcpEventInit[] = []
    tmuxWindows = 'codex\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      permissionMode: () => Promise.resolve('accept-edits'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'codex')).toBeDefined())
    acpConversationByHandle('demo', 'wt-1', 'codex')!.subscribe((e) => events.push(e))
    stream.feed(helloLine(true))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = stream.sent().find((m) => m.method === 'initialize')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: created.id,
      result: {
        sessionId: 'acp-1',
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'agent' }, { id: 'agent-full-access' }],
        },
      },
    })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(true))
    const setMode = stream.sent().find((m) => m.method === 'session/set_mode')!
    expect(setMode.params).toEqual({ sessionId: 'acp-1', modeId: 'workspace-write' })
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: setMode.id, error: { code: -32603, message: 'mode unavailable' },
    })}\n`)

    // `agent` (auto) is looser than accept-edits; `read-only` is not.
    await vi.waitFor(() => expect(stream.sent().filter((m) => m.method === 'session/set_mode')).toHaveLength(2))
    const stepDown = stream.sent().filter((m) => m.method === 'session/set_mode')[1]
    expect(stepDown.params).toEqual({ sessionId: 'acp-1', modeId: 'read-only' })
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: stepDown.id, result: {} })}\n`)

    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    const message = (events.find((e) => e.type === 'error') as { message: string }).message
    expect(message).toContain('workspace-write')
    // Names the mode actually in effect.
    expect(message).toContain('running in read-only')
    // The conversation survives.
    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined()
  })

  // The server went down between `initialize` and the `session/new` reply
  // (a restart right after a create), so the agent is live but nothing names
  // its conversation. `initialize` is not repeated on a live process.
  it('finishes a handshake a dropped connection began, from session/new', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, { dial: acpDial(() => stream), log: () => {} }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    stream.feed(helloLine(false))
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/new')).toBe(true))
    expect(stream.sent().some((m) => m.method === 'initialize')).toBe(false)
    const created = stream.sent().find((m) => m.method === 'session/new')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'acp-late' } })}\n`)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-late')).toBeDefined())
    expect(paneOptions.get('%0')).toBe('100:acp-late')
  })

  // Down after sending `session/new`, the server leaves the session opened
  // or about to be, in the record still under the workspace id. A second
  // `session/new` would leave an agent process idling beside the first, so
  // the reattach adopts that one, waiting for its reply if it has yet to land.
  it('adopts the session a dropped connection\'s session/new opened, waiting for its reply', async () => {
    const sent = [
      lifeLine,
      { jsonrpc: '2.0', id: 'old-1', method: 'initialize', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 'old-1', result: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 'old-2', method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } },
    ]
    await record('wt-1', sent)
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, { dial: acpDial(() => stream), log: () => {} }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(helloLine(false))
    await new Promise((resolve) => setTimeout(resolve, 400))

    await record('wt-1', [...sent, { jsonrpc: '2.0', id: 'old-2', result: { sessionId: 'acp-early' } }])
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-early')).toBeDefined())
    expect(stream.sent().filter((m) => m.method === 'initialize' || m.method === 'session/new')).toEqual([])
    expect(paneOptions.get('%0')).toBe('100:acp-early')
    // The record is renamed for the session, as a reply to this connection's
    // own `session/new` would have it.
    await vi.waitFor(() => expect(existsSync(path.join(acpLogDir('demo', 'wt-1'), 'acp-early.jsonl'))).toBe(true))
  })

  // A prewarmed spare's conversation has no row, so after a server restart
  // only its pane can name it.
  it('reattaches by the session its pane notes, but not one a respawn replaced', async () => {
    const connectFresh = (stream: FakeStream): void => {
      connections.push(agentDriver('acp').connect(session, () => {}, { dial: acpDial(() => stream), log: () => {} }))
    }
    tmuxWindows = 'claude\n'
    const first = new FakeStream()
    connectFresh(first)
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    first.feed(helloLine(true))
    await vi.waitFor(() => expect(first.sent().some((m) => m.method === 'initialize')).toBe(true))
    const init = first.sent().find((m) => m.method === 'initialize')!
    first.feed(`${JSON.stringify({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } })}\n`)
    await vi.waitFor(() => expect(first.sent().some((m) => m.method === 'session/new')).toBe(true))
    const created = first.sent().find((m) => m.method === 'session/new')!
    first.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'acp-warm' } })}\n`)
    await vi.waitFor(() => expect(paneOptions.get('%0')).toBe('100:acp-warm'))

    // A restarted server: the same agent process, and no row.
    for (const c of connections.splice(0)) c.close()
    _resetAcpRegistryForTests()
    const second = new FakeStream()
    connectFresh(second)
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    second.feed(helloLine(false))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-warm')).toBeDefined())
    expect(second.sent().some((m) => m.method === 'initialize')).toBe(false)

    // A respawned agent keeps the option but is a new process with a fresh
    // conversation, which must not load the old one.
    for (const c of connections.splice(0)) c.close()
    _resetAcpRegistryForTests()
    panePids.set('claude', '101')
    const third = new FakeStream()
    connectFresh(third)
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    third.feed(helloLine(true))
    await vi.waitFor(() => expect(third.sent().some((m) => m.method === 'initialize')).toBe(true))
    const reinit = third.sent().find((m) => m.method === 'initialize')!
    third.feed(`${JSON.stringify({ jsonrpc: '2.0', id: reinit.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })}\n`)
    await vi.waitFor(() => expect(third.sent().some((m) => m.method === 'session/new')).toBe(true))
    expect(third.sent().some((m) => m.method === 'session/load')).toBe(false)
  })

  // An idle stream can die without its close ever arriving; a respawn must
  // still reach the new agent rather than leave the window on a dead one.
  it('dials a respawned agent at the next re-list though the old stream never closed', async () => {
    const streams: FakeStream[] = []
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      heartbeatIntervalMs: 50,
      log: () => {},
      dial: acpDial(() => {
        const stream = new FakeStream()
        streams.push(stream)
        return stream
      }),
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    const stale = acpConversationByHandle('demo', 'wt-1', 'claude')

    panePids.set('claude', '101')
    await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 5_000 })
    expect(streams[0].killed).toBe(true)
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    expect(acpConversationByHandle('demo', 'wt-1', 'claude')).not.toBe(stale)
    // A steady pid is left attached.
    await new Promise((r) => setTimeout(r, 200))
    expect(streams).toHaveLength(2)
  })

  // A held create prompt goes back on the row only for a send no pane saw
  // fail, so it can never follow a retry the user made by hand.
  it('tells a message that was never sent from one the agent refused', async () => {
    await record('acp-r', [lifeLine])
    const stream = new FakeStream()
    tmuxWindows = 'opencode\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      heartbeatIntervalMs: 60_000,
      log: () => {},
      recordedSessions: () => Promise.resolve([{ handle: 'opencode', agentSessionId: 'acp-r' }]),
      dial: acpDial(() => stream),
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-r')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-r')!
    stream.feed(helloLine(false))
    await vi.waitFor(() => expect(conversation.status).toBe('waiting'))
    const prompts = (): Array<Record<string, unknown>> => stream.sent().filter((m) => m.method === 'session/prompt')

    const refused = conversation.prompt('first')
    await vi.waitFor(() => expect(prompts()).toHaveLength(1))
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: prompts()[0].id, error: { code: -32603, message: 'Session not found' },
    })}\n`)
    const err = await refused.then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PromptNotRunError)

    void conversation.prompt('second').catch(() => {})
    await vi.waitFor(() => expect(prompts()).toHaveLength(2))
    const queued = conversation.prompt('third')
    await vi.waitFor(() => expect(conversation.queuedPrompts).toHaveLength(1))
    conversation.close()
    await expect(queued).rejects.toBeInstanceOf(PromptNotRunError)
  })

  it('hands a queued message to the conversation that replaces a dropped one', async () => {
    // acpd keeps the agent across the drop, so what was queued is still owed.
    await record('acp-q', [lifeLine])
    const streams: FakeStream[] = []
    tmuxWindows = 'opencode\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      heartbeatIntervalMs: 60_000,
      log: () => {},
      recordedSessions: () => Promise.resolve([{ handle: 'opencode', agentSessionId: 'acp-q' }]),
      dial: acpDial(() => {
        const stream = new FakeStream()
        streams.push(stream)
        return stream
      }),
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-q')).toBeDefined())
    const first = acpConversation('demo', 'wt-1', 'acp-q')!
    streams[0].feed(helloLine(false))
    await vi.waitFor(() => expect(first.status).toBe('waiting'))
    void first.prompt('fix the build').catch(() => {})
    await vi.waitFor(() => expect(streams[0].sent().some((m) => m.method === 'session/prompt')).toBe(true))
    void first.prompt('then commit').catch(() => {})
    await vi.waitFor(() => expect(first.queuedPrompts.map((q) => q.text)).toEqual(['then commit']))

    streams[0].emitExit()
    await vi.waitFor(() => expect(streams.length).toBe(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-q')).toBeDefined())
    const replacement = acpConversation('demo', 'wt-1', 'acp-q')!
    expect(replacement).not.toBe(first)
    expect(replacement.queuedPrompts.map((q) => q.text)).toEqual(['then commit'])
    // Sent once the replacement knows no turn is running.
    streams[1].feed(helloLine(false))
    await vi.waitFor(() => expect(streams[1].sent().some((m) => m.method === 'session/prompt')).toBe(true))
    expect((streams[1].sent().find((m) => m.method === 'session/prompt')!.params as { prompt: Array<{ text: string }> })
      .prompt[0].text).toBe('then commit')
  })

  it('keeps the queue across the whole connection going down, for the reconnect to send', async () => {
    // A dropped tmux client takes the connection down and the watcher
    // reconnects; acpd kept every agent meanwhile. (A stop is the watcher's
    // to discard, see status-watcher's stop test.)
    await record('acp-s', [lifeLine])
    tmuxWindows = 'opencode\n'
    const seen: AgentObservation[] = []
    const connectWith = (stream: FakeStream): void => {
      connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
        heartbeatIntervalMs: 100,
        log: () => {},
        recordedSessions: () => Promise.resolve([{ handle: 'opencode', agentSessionId: 'acp-s' }]),
        dial: acpDial(() => stream),
      }))
    }
    const before = new FakeStream()
    connectWith(before)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-s')).toBeDefined())
    const first = acpConversation('demo', 'wt-1', 'acp-s')!
    before.feed(helloLine(false))
    await vi.waitFor(() => expect(first.status).toBe('waiting'))
    void first.prompt('fix the build').catch(() => {})
    await vi.waitFor(() => expect(before.sent().some((m) => m.method === 'session/prompt')).toBe(true))
    void first.prompt('then commit').catch(() => {})
    await vi.waitFor(() => expect(first.queuedPrompts).toHaveLength(1))

    lastTmux!.emitExit()
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'down')).toBe(true), { timeout: 5_000 })

    const after = new FakeStream()
    connectWith(after)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-s')).toBeDefined())
    const resumed = acpConversation('demo', 'wt-1', 'acp-s')!
    expect(resumed.queuedPrompts.map((q) => q.text)).toEqual(['then commit'])
    after.feed(helloLine(false))
    await vi.waitFor(() => expect(after.sent().some((m) => m.method === 'session/prompt')).toBe(true))
  })

  // tmux answering the probe while every re-list fails would leave the
  // connection up with nothing attached; the heartbeat redials instead.
  it('goes down when a heartbeat re-list fails though tmux answers', async () => {
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      heartbeatIntervalMs: 50, commandTimeoutMs: 1_000, log: () => {}, dial: acpDial(() => new FakeStream()),
    }))
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    failRelist = true
    await vi.waitFor(() => expect(seen.find((o) => o.kind === 'down')).toMatchObject({
      reason: expect.stringContaining('heartbeat failed') as string,
    }), { timeout: 5_000 })
  })

  it('waits in the dial for acpd to bind its socket, and re-dials one that never did', async () => {
    const streams: FakeStream[] = []
    const dials: string[][] = []
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      // A long settled interval, so only the fast retry after a drop can make
      // the second dial happen in time.
      heartbeatIntervalMs: 60_000,
      log: () => {},
      dial: acpDial((_s, argv) => {
        dials.push(argv)
        const stream = new FakeStream()
        streams.push(stream)
        // A dial whose wait ran out before acpd bound its socket closes.
        if (streams.length === 1) setTimeout(() => stream.emitExit(), 0)
        return stream
      }),
    }))

    await vi.waitFor(() => expect(streams.length).toBe(2), { timeout: 5_000 })
    // socat retries the connect itself, so a dial landing just before acpd
    // binds still connects once it does.
    expect(dials[0]).toEqual(['socat', '-', expect.stringMatching(/^UNIX-CONNECT:\S+\/claude\.sock,retry=\d+,interval=[\d.]+$/)])
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
  })

  // tmux pushes window adds, and a respawn into the placeholder fires its
  // boot subscription, so neither waits for the heartbeat or costs an exec.
  it('dials a new window and a respawned placeholder as tmux announces them', async () => {
    const dialed: string[] = []
    const seen: AgentObservation[] = []
    tmuxWindows = 'claude\n'
    placeholders.add('claude')
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      heartbeatIntervalMs: 600_000,
      log: () => {},
      dial: acpDial((_s, argv) => {
        dialed.push(argv.join(' '))
        return new FakeStream()
      }),
    }))
    // Still the placeholder: watched, not dialed.
    await vi.waitFor(() => expect(lastTmux?.writes.join('')).toContain("refresh-client -B 'boot-0:%0:"))
    expect(dialed).toEqual([])

    placeholders.delete('claude')
    lastTmux!.feed('%subscription-changed boot-0 $0 @0 0 %0 : 0\n')
    await vi.waitFor(() => expect(dialed).toHaveLength(1))
    expect(dialed[0]).toContain('claude.sock')

    tmuxWindows = 'claude\nclaude-2\n'
    lastTmux!.feed('%window-add @1\n')
    await vi.waitFor(() => expect(dialed).toHaveLength(2))
    expect(dialed[1]).toContain('claude-2.sock')
    // Passed up too, for the status watcher's terminal listing.
    expect(seen).toContainEqual({ kind: 'windows-changed' })
    expect(podExec).not.toHaveBeenCalled()
  })

  it('stops re-dialing a window that can never hold an attach', async () => {
    const streams: FakeStream[] = []
    tmuxWindows = 'claude\n'
    vi.useFakeTimers()
    try {
      connections.push(agentDriver('acp').connect(session, () => {}, {
        // Far apart, so the two intervals are distinguishable.
        heartbeatIntervalMs: 600_000,
        log: () => {},
        dial: acpDial(() => {
          // acpd is gone but its window remains, so every dial fails.
          const stream = new FakeStream()
          streams.push(stream)
          setTimeout(() => stream.emitExit(), 0)
          return stream
        }),
      }))

      // Fast retries stop after the limit.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(streams.length).toBe(MAX_FAST_ATTACH_ATTEMPTS)

      // The settled interval still re-dials, in case acpd comes back.
      await vi.advanceTimersByTimeAsync(600_000)
      expect(streams.length).toBe(MAX_FAST_ATTACH_ATTEMPTS + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('decodes a multi-byte character split across two socket reads', async () => {
    await recordMode('acp-1', 'bypassPermissions')
    // A character split across two chunks must not be decoded per chunk,
    // which would silently corrupt a JSON string.
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    const line = Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 'perm-🚀-1',
      method: 'session/request_permission',
      params: { sessionId: 'acp-1', options: [{ optionId: 'yes-🚀', kind: 'allow_always' }] },
    })}\n`, 'utf8')
    const rocket = line.indexOf(Buffer.from('🚀', 'utf8'))
    stream.feed(line.subarray(0, rocket + 2))
    stream.feed(line.subarray(rocket + 2))

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 'perm-🚀-1')).toBe(true))
    expect(stream.sent().find((m) => m.id === 'perm-🚀-1')!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-🚀' } })
  })

  it('steers a second prompt into the running turn instead of overlapping turns', async () => {
    // ACP adapters assume one turn at a time; overlapping would also let the
    // first reply end the second turn.
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    void conversation.prompt('first').catch(() => {})
    void conversation.prompt('second').catch(() => {})
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))

    // One turn on the wire, which the second message joins.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === '_session/steering')).toBe(true))
    expect(stream.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)
    expect((stream.sent().find((m) => m.method === '_session/steering')!.params as { prompt: Array<{ text: string }> }).prompt[0].text)
      .toBe('second')
  })

  it('drops a duplicate reply instead of ending the turn it is not about', async () => {
    // Only an id from another connection means "the previous turn ended". An
    // unknown id with this connection's prefix is a duplicate.
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    void conversation.prompt('go').catch(() => {})
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))
    const sent = stream.sent().find((m) => m.method === 'session/prompt')!

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(conversation.isBusy).toBe(false))
    void conversation.prompt('next').catch(() => {})
    await vi.waitFor(() => expect(conversation.isBusy).toBe(true))

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } })}\n`)
    await new Promise((r) => setTimeout(r, 30))
    // The second turn is still running.
    expect(conversation.isBusy).toBe(true)
  })

  it('survives a non-JSON line from the adapter instead of killing the conversation', async () => {
    await recordMode('acp-1', 'bypassPermissions')
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: acpDial(() => stream),
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())

    // Non-JSON output on stdout must not break the conversation.
    stream.feed('warning: something to stderr-ish\n')
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 'perm-after-noise',
      method: 'session/request_permission',
      params: { sessionId: 'acp-1', options: [{ optionId: 'yes', kind: 'allow_always' }] },
    })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 'perm-after-noise')).toBe(true))
  })

  /**
   * A tui prompt is pasted by a detached in-workspace script, so the exec
   * returns before the script's polling ends. The script is run here
   * against a stub `tmux` (and a no-op `sleep`) that records what changed
   * the pane.
   */
  describe('tui prompt delivery', () => {
    let bin: string
    beforeEach(() => {
      bin = mkdtempSync(path.join(os.tmpdir(), 'yaac-paste-'))
      writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 })
      writeFileSync(path.join(bin, 'tmux'), [
        '#!/bin/sh',
        'shift 2',
        'case "$1" in',
        '  display) echo 1 ;;',
        '  capture-pane) cat "$STUB/screen" 2>/dev/null ;;',
        '  load-buffer) cat > "$STUB/buffer" ;;',
        '  paste-buffer)',
        '    echo paste >> "$STUB/calls"',
        '    case "$RENDER" in',
        '      text) cat "$STUB/buffer" > "$STUB/screen" ;;',
        '      claude) tr "\\t\\r" "  " < "$STUB/buffer" | fold -w 7 | tail -n 6 > "$STUB/screen" ;;',
        '      marker) echo "> [paste #1 +13 lines]" > "$STUB/screen" ;;',
        '    esac ;;',
        '  send-keys) echo "send-keys $4" >> "$STUB/calls" ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o755 })
    })
    afterEach(() => { rmSync(bin, { recursive: true, force: true }) })

    /** The script a delivery would leave running in the workspace. */
    async function deliveredScript(prompt: string): Promise<string> {
      await agentDriver('tui').deliverPrompt(session, '%3', prompt)
      const [jobName, cmd, opts] = podExec.mock.calls.at(-1)!
      expect(jobName).toBe(session.jobName)
      // One attempt: a retried paste would submit the prompt twice.
      expect(opts).toEqual({ maxAttempts: 1, timeout: 15_000 })
      const b64 = /^printf %s ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/\.yaac-prompt\.sh && /.exec(cmd)?.[1]
      // Detached, by setsid where the host has it and nohup on macOS.
      expect(cmd).toContain('then setsid sh /tmp/.yaac-prompt.sh; else nohup sh /tmp/.yaac-prompt.sh; fi; }'
        + ' >/tmp/yaac-prompt.log 2>&1 </dev/null &')
      return Buffer.from(b64!, 'base64').toString('utf8')
    }

    /**
     * How the stub pane renders a paste:
     * - `text`: verbatim, like a wide input box.
     * - `claude`: tabs and CRs as spaces, wrapped at 7 columns, only the
     *   last 6 rows visible, like claude's input box in a small window.
     * - `marker`: a collapsed-paste placeholder, as pi and codex show a
     *   long paste.
     * - `none`: nothing, like a dialog that swallows the keys.
     */
    async function run(render: 'text' | 'claude' | 'marker' | 'none', prompt = 'hello there') {
      const script = await deliveredScript(prompt)
      writeFileSync(path.join(bin, 'calls'), '')
      rmSync(path.join(bin, 'screen'), { force: true })
      const res = spawnSync('sh', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB: bin, RENDER: render },
      })
      const calls = readFileSync(path.join(bin, 'calls'), 'utf8').trim().split('\n')
      return { status: res.status ?? -1, calls }
    }
    const submitted = { status: 0, calls: ['paste', 'send-keys Enter', 'send-keys Enter'] }

    it('carries any text to the pane intact as a bracketed paste, but no control sequence', async () => {
      const nasty = 'say "hi" && don\'t eval `$HOME`\nsecond line — ünïcode'
      // An escape could end the bracketed paste and type the rest as keys.
      const script = await deliveredScript(`${nasty}\x1b[201~\x1b[Z\x07\r\u009b`)
      expect(script).not.toContain('$HOME')
      const b64 = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| tmux[^|]*load-buffer/.exec(script)?.[1]
      expect(Buffer.from(b64!, 'base64').toString('utf8')).toBe(`${nasty}[201~[Z`)
      expect(script).toContain('paste-buffer -p -d -b yaac-prompt-$$ -t %3')
      expect(script).toContain('send-keys -t %3 Enter')
    })

    it('submits once the paste shows in the pane however the TUI wraps, scrolls or collapses it', async () => {
      expect(await run('text')).toEqual(submitted)
      // CRLF endings, wrapped lines, and a first line that scrolls out of
      // view, so only the last-20 probe can match under `claude`.
      const long = `Please\tfix the flaky login test todayxx\u{1F642} now\r\n${'more detail\r\n'.repeat(8)}thanks`
      expect(await run('claude', long)).toEqual(submitted)
      expect(await run('marker', long)).toEqual(submitted)
      // 19 visible characters on each side of the emoji, so the first-20 and
      // last-20 probes both reach it; a UTF-16 slice would cut it in half.
      expect(await run('claude', 'Please\tfix the flakyyy\u{1F642} login test is red today')).toEqual(submitted)
    })

    it('never presses Enter on a pane that does not show the paste', async () => {
      // A startup dialog (claude's folder trust) swallows the paste, and
      // Enter there would pick its preselected "No, exit".
      expect(await run('none')).toEqual({ status: 1, calls: Array<string>(10).fill('paste') })
    })

    it('pastes a whitespace-only prompt once, blind', async () => {
      const script = await deliveredScript(' \n ')
      expect(script).not.toContain('head=')
      expect(script).toContain('paste-buffer -p -d -b yaac-prompt-$$ -t %3')
    })
  })

  /**
   * A message to a running agent (`running`) runs in the foreground, against
   * a stub `tmux` that plays a small TUI per `$TOOL`: a transcript of what
   * was submitted, an input box holding `$STUB/input`, and each tool's way of
   * setting a draft aside (claude's one-slot stash and kill ring, codex's history,
   * opencode's stash stack, pi's message key). `$STUB/dialog` replaces the
   * input box with a dialog that takes no keys (and hides codex's cursor),
   * and `$ENTER_DIALOG` is one the submit raises.
   */
  describe('messages to a running agent', () => {
    let bin: string
    beforeEach(() => {
      bin = mkdtempSync(path.join(os.tmpdir(), 'yaac-message-'))
      writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 })
      writeFileSync(path.join(bin, 'tmux'), [
        '#!/bin/sh',
        'shift 2',
        'S=$STUB; touch "$S/input" "$S/transcript" "$S/history" "$S/stack"',
        'enc() { base64 | tr -d "\\n"; }',
        'submit() { [ -s "$S/input" ] && { cat "$S/input"; echo; } >> "$S/transcript"; : > "$S/input"; }',
        '# The input box, its first line prefixed $1 and the rest $2.',
        'lines() { awk -v a="$1" -v b="$2" \'{ print (NR == 1 ? a : b) $0 }\' "$S/input"; }',
        'render() {',
        '  [ "$TOOL" = opencode ] && echo "${LABEL:-   } New session"',
        '  cat "$S/transcript"',
        '  if [ -s "$S/dialog" ]; then cat "$S/dialog"; return; fi',
        '  case "$TOOL" in',
        '    claude) [ -s "$S/stash" ] && echo "                    › stashed"; echo "────────"',
        '      if [ -s "$S/input" ]; then lines "❯\\302\\240" "  "; else printf "❯\\302\\240\\n"; fi',
        '      echo "────────"; echo "  ⏸ manual mode on" ;;',
        '    codex) if [ -s "$S/input" ]; then lines "› " "  "; else echo "› "; fi',
        '      echo; [ -s "$S/input" ] && echo "  tab to queue message" || echo "  ? for shortcuts" ;;',
        '    opencode) echo "┃"; [ -s "$S/input" ] && lines "┃  " "┃  "; echo "┃"; echo "┃  Build · M Mock" ;;',
        '  esac',
        '}',
        'case "$1" in',
        '  display) case "$*" in',
        '    *cursor_y*) n=$(render | grep -n "^›" | tail -n 1 | cut -d: -f1); [ -s "$S/dialog" ] && echo "0 0" || echo "1 $((n - 1))" ;;',
        '    *cursor_flag*) [ -s "$S/dialog" ] && echo 0 || echo 1 ;;',
        '    *) echo "$TITLE" ;;',
        '  esac ;;',
        '  capture-pane) render ;;',
        '  load-buffer) cat > "$S/buffer" ;;',
        '  paste-buffer)',
        '    echo paste >> "$S/calls"',
        '    [ -z "$RAISE" ] || printf %s "$RAISE" > "$CLAUDE_CONFIG_DIR/sessions/1.json"',
        '    [ -s "$S/dialog" ] || cat "$S/buffer" >> "$S/input" ;;',
        '  send-keys) shift 3; for k in "$@"; do echo "send-keys $k" >> "$S/calls"; case "$TOOL $k" in',
        '    *Enter) submit; echo 0 > "$S/ups"; printf %s "$ENTER_DIALOG" > "$S/dialog"',
        '      [ "$TOOL" = claude ] && [ -s "$S/stash" ] && { mv "$S/stash" "$S/input"; } ;;',
        '    "claude C-s") if [ -s "$S/input" ]; then mv "$S/input" "$S/stash"; elif [ -s "$S/stash" ]; then mv "$S/stash" "$S/input"; fi ;;',
        '    "claude C-u") [ -s "$S/input" ] && mv "$S/input" "$S/kill"; touch "$S/input" ;;',
        '    "claude C-y") cat "$S/kill" >> "$S/input" ;;',
        '    "codex C-c") [ -s "$S/input" ] && { enc < "$S/input"; echo; } >> "$S/history"; : > "$S/input" ;;',
        '    "codex Up") n=$(($(cat "$S/ups" 2>/dev/null || echo 0) + 1)); echo $n > "$S/ups"',
        '      tail -n $n "$S/history" | head -n 1 | base64 -d > "$S/input" ;;',
        '    "opencode f9") [ -s "$S/input" ] && { enc < "$S/input"; echo; } | tee -a "$S/stack" >> "$XDG_STATE_HOME/opencode/prompt-stash.jsonl"; : > "$S/input" ;;',
        '    "opencode f10") tail -n 1 "$S/stack" | base64 -d > "$S/input"; sed -i "\\$d" "$S/stack" ;;',
        '    "pi f9") f="$PI_CODING_AGENT_DIR/yaac-messages/conv-1.txt"; { cat "$f"; echo; } >> "$S/transcript"; rm -f "$f" ;;',
        '  esac; done ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o755 })
    })
    afterEach(() => { rmSync(bin, { recursive: true, force: true }) })

    const MESSAGE = 'Sent from peer via yaac-mama:\n\nhello there'

    /**
     * Deliver `MESSAGE` to `tool`'s conversation `conv-1`, whose input box
     * holds `opts.draft`; for claude, its presence file says `opts.claude`
     * (`idle` by default, none when null) and `opts.raise` once pasted into,
     * and `opts.stash` is a stash its user made. Returns the exit status, the
     * keys sent, and what was submitted and left in the box.
     */
    async function send(tool: AgentTool, opts: {
      draft?: string; stash?: string; claude?: string | null; raise?: string; title?: string; dialog?: string
      enterDialog?: string; label?: string
    } = {}) {
      await agentDriver('tui').deliverPrompt({ ...session, tool }, '%3', MESSAGE, { running: { agentSessionId: 'conv-1' } })
      const [, cmd, execOpts] = podExec.mock.calls.at(-1)!
      expect(execOpts).toEqual({ maxAttempts: 1, timeout: 30_000 })
      const file = (name: string): string => path.join(bin, name)
      for (const name of ['calls', 'input', 'transcript', 'history', 'stack', 'stash', 'kill', 'ups']) rmSync(file(name), { force: true })
      writeFileSync(file('input'), opts.draft ?? '')
      writeFileSync(file('dialog'), opts.dialog ?? '')
      if (opts.stash !== undefined) writeFileSync(file('stash'), opts.stash)
      const sessions = file('claude/sessions')
      mkdirSync(sessions, { recursive: true })
      rmSync(path.join(sessions, '1.json'), { force: true })
      const presence = (status: string): string => JSON.stringify({ pid: 1, sessionId: 'conv-1', status })
      if (opts.claude !== null) writeFileSync(path.join(sessions, '1.json'), presence(opts.claude ?? 'idle'))
      mkdirSync(file('state/opencode'), { recursive: true })
      writeFileSync(file('state/opencode/prompt-stash.jsonl'), '')
      mkdirSync(file('pi'), { recursive: true })
      const res = spawnSync('sh', ['-c', cmd], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STUB: bin,
          TOOL: tool,
          TITLE: opts.title ?? '',
          ENTER_DIALOG: opts.enterDialog ?? '',
          LABEL: opts.label ?? '',
          RAISE: opts.raise === undefined ? '' : presence(opts.raise),
          CLAUDE_CONFIG_DIR: file('claude'),
          XDG_STATE_HOME: file('state'),
          PI_CODING_AGENT_DIR: file('pi'),
        },
      })
      const read = (name: string): string => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '')
      return {
        status: res.status ?? -1,
        calls: read('calls').trim().split('\n').filter(Boolean),
        submitted: read('transcript'),
        input: read('input'),
        stash: read('stash'),
        history: read('history').trim().split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64').toString('utf8')),
        stack: read('stack').trim().split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64').toString('utf8')),
      }
    }

    it('submits the message on its own and puts the user\'s draft back, per tool', async () => {
      const draft = 'my draft\nsecond line'
      const delivered = `${MESSAGE}\n`
      // An empty box: one paste, one Enter.
      expect(await send('claude')).toMatchObject({
        status: 0, calls: ['paste', 'send-keys Enter'], submitted: delivered, input: '',
      })
      // claude stashes the draft and restores it itself on the submit.
      expect(await send('claude', { draft })).toMatchObject({
        status: 0, calls: ['send-keys C-s', 'paste', 'send-keys Enter'], submitted: delivered, input: draft,
      })
      // codex clears it into its history and recalls it past the message.
      expect(await send('codex', { draft })).toMatchObject({
        status: 0, submitted: delivered, input: draft,
      })
      // opencode pushes it onto its stash stack and pops it.
      expect(await send('opencode', { draft })).toMatchObject({
        status: 0, calls: ['send-keys f9', 'paste', 'send-keys Enter', 'send-keys f10'], submitted: delivered, input: draft,
      })
      // pi's extension submits the message without touching the editor.
      expect(await send('pi', { draft })).toMatchObject({
        status: 0, calls: ['send-keys f9'], submitted: delivered, input: draft,
      })
    })

    it('keeps a claude user\'s own stash, cutting a draft beside it instead', async () => {
      // Our submit restores their stash into the empty box; it goes back.
      expect(await send('claude', { stash: 'their stash' })).toMatchObject({
        status: 0, submitted: `${MESSAGE}\n`, input: '', stash: 'their stash',
      })
      // claude keeps one stash, so a draft beside it is cut from its end,
      // then yanked back once their stash is back in place.
      expect(await send('claude', { stash: 'their stash', draft: 'their draft\nline two' })).toMatchObject({
        status: 0, submitted: `${MESSAGE}\n`, input: 'their draft\nline two', stash: 'their stash',
      })
      // The kill ring keeps a paste's placeholder but not the paste.
      expect(await send('claude', { stash: 'their stash', draft: 'see [Pasted text #1 +30 lines]' })).toMatchObject({
        status: 5, calls: [], submitted: '', input: 'see [Pasted text #1 +30 lines]', stash: 'their stash',
      })
    })

    it('types nothing into an agent showing a dialog, and never submits into one', async () => {
      const refused = { status: 3, calls: [], submitted: '' }
      // claude reports `waiting` under a permission prompt or a question,
      // and has no presence file before its startup dialogs are through.
      expect(await send('claude', { claude: 'waiting' })).toMatchObject(refused)
      expect(await send('claude', { claude: null })).toMatchObject(refused)
      // A dialog that opens once the text is in gets no Enter.
      expect(await send('claude', { raise: 'waiting' })).toMatchObject({ status: 4, calls: ['paste'], submitted: '' })
      // codex titles approvals, and hides its cursor under every dialog, its
      // plan prompt included, whose options look like a composer holding
      // text. Nothing is sent to it, so no C-c either.
      expect(await send('codex', { title: '[ ! ] Action Required | cxt', draft: 'mine' })).toMatchObject({ ...refused, input: 'mine' })
      expect(await send('codex', { dialog: '› 1. Yes, implement this plan\n  enter select · esc back' }))
        .toMatchObject(refused)
      // opencode marks its tab label.
      expect(await send('opencode', { label: ' ! ' })).toMatchObject(refused)
      expect(await send('opencode', { label: ' ? ' })).toMatchObject(refused)
    })

    it('leaves a draft set aside, sending no more keys, when the message raises a dialog', async () => {
      const draft = 'my draft'
      const approval = '› 1. Yes, proceed (y)\n  Press enter to confirm or esc to cancel'
      // The draft stays in codex's history, where Up brings it back once
      // the dialog is answered; Up now would move the approval's choice.
      expect(await send('codex', { draft, enterDialog: approval })).toMatchObject({
        status: 0, calls: ['send-keys C-c', 'paste', 'send-keys Enter'], submitted: `${MESSAGE}\n`, history: [draft],
      })
      // And on opencode's stash stack, where its pop key brings it back.
      expect(await send('opencode', { draft, enterDialog: '△ Permission required' })).toMatchObject({
        status: 0, calls: ['send-keys f9', 'paste', 'send-keys Enter'], stack: [draft],
      })
    })
  })

  describe('tui launch lines', () => {
    describe('codex tool', () => {
      // The command without its `-c` settings (pinned by the argv case below).
      const bare = (cmd: string): string => cmd.replace(/ -c "(?:[^"\\]|\\.)*"/g, '')

      it('omits prompt arguments', () => {
        const cmd = tuiLaunchCmd({ tool: 'codex', workspaceId: 'sess-1', permissionMode: 'bypass' })
        expect(bare(cmd)).toBe('codex -C /workspace --dangerously-bypass-hook-trust --yolo')
      })

      it('resumes the conversation it is given', () => {
        const cmd = tuiLaunchCmd({ tool: 'codex', workspaceId: 'sess-1', resume: true, permissionMode: 'bypass' })
        expect(bare(cmd)).toBe('codex -C /workspace --dangerously-bypass-hook-trust --yolo resume sess-1')
      })

      it('runs codex in the workspace, trusts the repository, and opens no startup screen', () => {
        // Run the command with `codex` replaced by an argv printer.
        const cmd = tuiLaunchCmd({
          tool: 'codex',
          workspaceId: 'sess-1',
          permissionMode: 'accept-edits',
          paths: { workspaceDir: '/data/wt' },
        })
        const argv = execFileSync('sh', ['-c', cmd.replace(/^codex /, `printf '%s\\n' `)], {
          env: { ...process.env, CODEX_HOME: '/must/not/expand' },
        }).toString().trimEnd().split('\n')
        expect(argv).toEqual([
          // Explicit, so a resume never asks which directory to use.
          '-C', '/data/wt',
          // yaac learns of a `/model` change from the title's last segment.
          '-c', 'tui.terminal_title=["activity","project-name","model"]',
          // Otherwise an outdated codex opens an "Update available" screen.
          '-c', 'check_for_update_on_startup=false',
          // A shared background server would run yaac's hooks outside the pane.
          '-c', 'features.daemon_auto_start=false',
          // Its worktrees would go in the project's shared codex home.
          '-c', 'features.worktrees=false',
          // Trust the folder and run yaac's hooks without asking, so no startup
          // screen swallows the pasted prompt.
          '-c', 'projects={"/data/wt"={trust_level="trusted"}}',
          '--dangerously-bypass-hook-trust',
          // codex's defaults, named so a resume does not restore another posture.
          '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-c', 'approvals_reviewer=user',
        ])
      })

      it('inserts --model when a model override is given', () => {
        const cmd = tuiLaunchCmd({ tool: 'codex', workspaceId: 'sess-1', resume: false, model: 'gpt-5.2-codex', permissionMode: 'bypass' })
        expect(bare(cmd)).toBe('codex -C /workspace --dangerously-bypass-hook-trust --yolo --model gpt-5.2-codex')
      })

      it('places --model after the resume subcommand (codex resume parses it)', () => {
        const cmd = tuiLaunchCmd({ tool: 'codex', workspaceId: 'abc', resume: true, model: 'gpt-5.2-codex', permissionMode: 'bypass' })
        expect(cmd).toMatch(/ --yolo resume abc --model gpt-5\.2-codex$/)
      })
    })

    describe('opencode tool', () => {
      // The permission posture is in OPENCODE_CONFIG_CONTENT (tested below).
      it('runs the TUI over a private server of its own', () => {
        const cmd = tuiLaunchCmd({ tool: 'opencode', workspaceId: 'sess-1', permissionMode: 'bypass' })
        expect(cmd).toMatch(/ opencode --standalone$/)
      })

      it('resumes a session by id', () => {
        const cmd = tuiLaunchCmd({ tool: 'opencode', workspaceId: 'ses_1', resume: true, permissionMode: 'bypass' })
        expect(cmd).toMatch(/^OPENCODE_CONFIG_CONTENT=.* opencode --standalone --session ses_1$/)
      })

      it('carries a provider/model override in the config, never as a flag', () => {
        // The TUI has no --model flag and refuses unknown flags.
        const cmd = tuiLaunchCmd({ tool: 'opencode', workspaceId: 'sess-1', resume: false, model: 'anthropic/claude-opus-4-8', permissionMode: 'bypass' })
        expect(cmd).not.toContain('--model')
        expect(opencodeConfigOf(cmd).model).toBe('anthropic/claude-opus-4-8')
        // Its prompt stash ships unbound; a message to it needs keys for it.
        expect(cmd).toContain('OPENCODE_CLI_CONFIG_CONTENT="{\\"keybinds\\":{\\"prompt.stash\\":\\"f9\\",\\"prompt.stash.pop\\":\\"f10\\"}}"')
      })
    })

    describe('pi tool', () => {
      const defaultModel = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel
      const anthropicModel = piProviderInfo('anthropic').defaultModel

      // pi's stderr goes through sed to drop the first "Warning: No project
      // session found with id ..." line, including any leading color codes.
      const wrapped = (piCmd: string) =>
        `${piCmd} 2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: No project session found with id .*creating a new session with that id\\./{//d}" >&2)`

      it('uses --approve, the default provider model, and --session-id when none is given', () => {
        const cmd = tuiLaunchCmd({ tool: 'pi', workspaceId: 'sess-1', permissionMode: 'bypass' })
        expect(cmd).toBe(wrapped(`pi --approve --tui-mode fullscreen --model ${defaultModel} --session-id sess-1`))
      })

      it('uses the given provider default model', () => {
        const cmd = tuiLaunchCmd({ tool: 'pi', workspaceId: 'sess-1', resume: false, piProvider: 'anthropic', permissionMode: 'bypass' })
        expect(cmd).toBe(wrapped(`pi --approve --tui-mode fullscreen --model ${anthropicModel} --session-id sess-1`))
      })

      it('addresses the session by id when resuming (same command as create)', () => {
        const cmd = tuiLaunchCmd({ tool: 'pi', workspaceId: 'sess-1', resume: true, piProvider: 'anthropic', permissionMode: 'bypass' })
        expect(cmd).toBe(wrapped(`pi --approve --tui-mode fullscreen --model ${anthropicModel} --session-id sess-1`))
      })

      it('prefers an explicit model override over the provider default', () => {
        const cmd = tuiLaunchCmd({ tool: 'pi', workspaceId: 'sess-1', resume: false, piProvider: 'anthropic', model: 'openai/gpt-5.2', permissionMode: 'bypass' })
        expect(cmd).toBe(wrapped('pi --approve --tui-mode fullscreen --model openai/gpt-5.2 --session-id sess-1'))
      })

      it('filters the fresh-run warning without single quotes (survives respawn wrapper)', () => {
        const cmd = tuiLaunchCmd({ tool: 'pi', workspaceId: 'sess-1', permissionMode: 'bypass' })
        // No single quotes: the command is embedded in `respawn-window '<cmd>'`.
        expect(cmd).not.toContain("'")
        // Anchored at line start, and only the first match is deleted.
        expect(cmd).toContain('2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*Warning: ')
        expect(cmd).toContain('creating a new session with that id\\./{//d}" >&2)')
      })
    })

    describe('claude tool', () => {
      // claude animates its title (the pane's status signal) only when `$TMUX`
      // is unset, so every claude launch below must include `env -u TMUX`.
      it('hides $TMUX so the title keeps animating, and omits prompt flags', () => {
        const cmd = tuiLaunchCmd({ tool: 'claude', workspaceId: 'sess-1', permissionMode: 'bypass' })
        expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --session-id sess-1')
      })

      it('swaps --session-id for --resume when resuming', () => {
        const cmd = tuiLaunchCmd({ tool: 'claude', workspaceId: 'sess-1', resume: true, permissionMode: 'bypass' })
        expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --resume sess-1')
      })

      it('inserts --model when a model override is given', () => {
        const cmd = tuiLaunchCmd({ tool: 'claude', workspaceId: 'sess-1', resume: false, model: 'claude-opus-4-8', permissionMode: 'bypass' })
        expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model claude-opus-4-8 --session-id sess-1')
      })

      it('combines a model override with resume', () => {
        const cmd = tuiLaunchCmd({ tool: 'claude', workspaceId: 'sess-1', resume: true, model: 'opus', permissionMode: 'bypass' })
        expect(cmd).toBe('env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode bypassPermissions --model opus --resume sess-1')
      })
    })

    // Each tool expresses postures differently, so every (tool, posture) pair
    // is asserted.
    describe('permission modes', () => {
      const CASES: [AgentTool, PermissionMode, string][] = [
        ['claude', 'bypass', 'claude --permission-mode bypassPermissions'],
        ['claude', 'auto', 'claude --permission-mode auto'],
        ['claude', 'accept-edits', 'claude --permission-mode acceptEdits'],
        ['claude', 'plan', 'claude --permission-mode plan'],
        ['claude', 'manual', 'claude --permission-mode manual'],
        ['codex', 'bypass', ' --yolo'],
        ['codex', 'auto', ' --approve-for-me'],
        ['codex', 'accept-edits', ' --sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=user'],
        ['codex', 'plan', ' --sandbox read-only --ask-for-approval on-request -c approvals_reviewer=user'],
      ]

      it.each(CASES)('%s in %s mode', (tool, permissionMode, expected) => {
        expect(tuiLaunchCmd({ tool, workspaceId: 'sess-1', permissionMode })).toContain(expected)
      })

      // opencode's base policy starts with `* allow` and ignores unknown
      // actions, so a misspelled rule silently allows everything. Hence exact
      // assertions. There is no posture flag; the TUI would refuse one.
      it('spells every opencode posture in rules opencode actually reads', () => {
        const postureOf = (permissionMode: PermissionMode): OpencodeConfig => {
          const cmd = tuiLaunchCmd({ tool: 'opencode', workspaceId: 's', permissionMode })
          // Escaped double quotes only: the command is embedded in
          // `respawn-window '<cmd>'`, and bare braces would be expanded by zsh.
          expect(cmd).not.toContain("'")
          expect(cmd).not.toContain('--auto')
          expect(cmd).not.toContain('--agent')
          return opencodeConfigOf(cmd)
        }
        const rule = (action: string, effect: string) => ({ action, resource: '*', effect })

        // Bypass explicitly allows everything; the base policy would still ask
        // for some things.
        expect(postureOf('bypass')).toEqual({ permissions: [rule('*', 'allow')] })
        // Manual asks before any action (wildcard first, to cover tools the base
        // policy allows), then re-allows reads and restates the .env asks.
        const askToAct = [
          rule('*', 'ask'),
          rule('read', 'allow'), rule('glob', 'allow'), rule('grep', 'allow'), rule('question', 'allow'),
          { action: 'read', resource: '*.env', effect: 'ask' },
          { action: 'read', resource: '*.env.*', effect: 'ask' },
        ]
        expect(postureOf('manual')).toEqual({ permissions: askToAct })
        // Accept-edits also allows `edit` (which covers edit, write and patch).
        expect(postureOf('accept-edits')).toEqual({ permissions: [...askToAct, rule('edit', 'allow')] })
        // Plan uses opencode's plan agent, plus the same rules since that agent
        // would otherwise run commands unprompted.
        expect(postureOf('plan')).toEqual({ default_agent: 'plan', permissions: askToAct })
      })

      // opencode silently ignores unknown actions, so check every name against
      // the pinned binary's list.
      it('names only actions the pinned opencode binary knows', () => {
        for (const mode of ['bypass', 'accept-edits', 'manual', 'plan'] as const) {
          const cmd = tuiLaunchCmd({ tool: 'opencode', workspaceId: 's', permissionMode: mode })
          for (const r of opencodeConfigOf(cmd).permissions ?? []) {
            expect(OPENCODE_ACTIONS).toContain(r.action)
          }
        }
      })

      // Run through a real shell: config opencode cannot parse fails open.
      it('delivers the opencode posture through the shell it is embedded in', () => {
        const cmd = tuiLaunchCmd({ tool: 'opencode', workspaceId: 's', permissionMode: 'manual' })
        const env = /^(OPENCODE_CONFIG_CONTENT=\S+)/.exec(cmd)?.[1] ?? ''
        const out = execFileSync('sh', ['-c', `${env} printenv OPENCODE_CONFIG_CONTENT`], { encoding: 'utf8' })
        expect(JSON.parse(out) as OpencodeConfig).toEqual(opencodeConfigOf(cmd))
      })

      // A workspace row may name a posture the tool lacks. Each falls back to
      // the loosest posture the tool has that is no looser than the row's.
      it('falls back to the nearest posture a tool actually has', () => {
        // pi has no permission system, so every posture is effectively bypass.
        const piManual = tuiLaunchCmd({ tool: 'pi', workspaceId: 's', permissionMode: 'manual' })
        expect(piManual).toBe(tuiLaunchCmd({ tool: 'pi', workspaceId: 's', permissionMode: 'bypass' }))
        expect(piManual).toContain('pi --approve')
        // opencode has no reviewer model, so `auto` becomes accept-edits.
        expect(tuiLaunchCmd({ tool: 'opencode', workspaceId: 's', permissionMode: 'auto' }))
          .toBe(tuiLaunchCmd({ tool: 'opencode', workspaceId: 's', permissionMode: 'accept-edits' }))
        // The pinned codex has no `manual`, so it falls back to read-only (plan).
        expect(tuiLaunchCmd({ tool: 'codex', workspaceId: 's', permissionMode: 'manual' }))
          .toBe(tuiLaunchCmd({ tool: 'codex', workspaceId: 's', permissionMode: 'plan' }))
        // An unknown posture gets the tool's strictest.
        expect(tuiLaunchCmd({ tool: 'claude', workspaceId: 's', permissionMode: 'dontAsk' as PermissionMode }))
          .toContain('--permission-mode plan')
      })
    })

    // Every launch names its effort, since an in-session change is saved to
    // the project's shared tool home and would otherwise carry into this one
    // (docs/effort-levels.md).
    describe('effort', () => {
      const launch = (tool: AgentTool, extra: { model?: string; resume?: boolean } = {}): string =>
        tuiLaunchCmd({ tool, workspaceId: 's', permissionMode: 'bypass', effort: 'high', ...extra })

      it("passes each tool's own flag, and none when unset", () => {
        expect(launch('claude', { resume: true })).toMatch(/ --effort high --resume s$/)
        expect(launch('pi')).toContain(' --thinking high --session-id s')
        // Before `resume`, so it binds to a resumed conversation too.
        expect(launch('codex', { resume: true })).toMatch(/ -c "model_reasoning_effort=high" .*resume s/)
        for (const tool of ['claude', 'codex', 'pi'] as const) {
          expect(tuiLaunchCmd({ tool, workspaceId: 's', permissionMode: 'bypass' })).not.toMatch(/effort|thinking/)
        }
      })

      // opencode takes a variant only on an agent, beside its model, and on
      // both agents so a Tab keeps it; `default` is no variant at all.
      it('gives opencode the variant on both agents through the shell it is embedded in', () => {
        const cmd = launch('opencode', { model: 'openai/gpt-5' })
        const env = /^(OPENCODE_CONFIG_CONTENT=\S+)/.exec(cmd)?.[1] ?? ''
        const out = execFileSync('sh', ['-c', `${env} printenv OPENCODE_CONFIG_CONTENT`], { encoding: 'utf8' })
        expect((JSON.parse(out) as { agent?: unknown }).agent).toEqual({
          build: { model: 'openai/gpt-5', variant: 'high' },
          plan: { model: 'openai/gpt-5', variant: 'high' },
        })
        const plain = tuiLaunchCmd({
          tool: 'opencode', workspaceId: 's', permissionMode: 'bypass', model: 'openai/gpt-5', effort: 'default',
        })
        expect(plain).not.toContain('agent')
      })
    })
  })
})
