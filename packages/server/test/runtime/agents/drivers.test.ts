import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
import {
  _resetAcpRegistryForTests,
  acpConversation,
  acpConversationByHandle,
} from '#runtime/agents/acp-registry'
import { installFakeWorkspaceDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import type { StreamChild, WorkspaceDriver } from '#drivers/contract'
import type { AcpConversation } from '#runtime/agents/acp-client'
import type { AcpEventInit } from '@yaac/shared/acp'
import {
  AGENT_TOOLS,
  SUPPORTED_PERMISSION_MODES,
} from '@yaac/shared/types'
import { _ACP_PROFILES } from '#runtime/agents/acp-adapters'
import type { PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'

/** A pi conversation's model when none is named: the provider's default. */
const PI_DEFAULT_MODEL = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel

/**
 * Drives each agent driver as the status watcher does: connect, feed the
 * pod's side of the stream, and assert the observations. Only the driver's
 * dial and exec are mocked; tmux control mode, JSON-RPC and ACP handling run
 * for real.
 */

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
      const body = data.startsWith('list-windows')
        ? tmuxWindows.split('\n').filter((w) => w !== '')
          .map((w, i) => `${w}\t%${String(i)}\t${placeholders.has(w) ? '1' : '0'}\n`).join('')
        : ''
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
  slug: 'demo',
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
  const dir = acpLogDir(session.slug, session.workspaceId)
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
  lifeLine,
  { jsonrpc: '2.0', id: 'h-1', method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } },
  { jsonrpc: '2.0', id: 'h-1', result: { sessionId: agentSessionId, modes: { currentModeId: modeId } } },
])

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
  placeholders.clear()
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
    // The adapter takes no flags, so the model goes in an env var.
    const withModel = agentDriver('acp').launchCmd({ ...spec, model: 'claude-opus-5-5' })
    expect(withModel).toMatch(/^ANTHROPIC_MODEL=claude-opus-5-5 node /)
    expect(withModel).not.toContain('--model')
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

    // codex-acp takes no flags: the model goes through the environment, and
    // browser login is disabled since a workspace cannot open one.
    const codex = spec('codex')
    expect(codex).toContain('NO_BROWSER=1 CODEX_PATH=codex node /opt/yaac/acpd/main.js')
    expect(codex).toContain('-- codex-acp')
    expect(codex).not.toContain('CODEX_CONFIG')
    expect(spec('codex', { model: 'gpt-5.2-codex' }))
      .toContain('CODEX_CONFIG="{\\"model\\":\\"gpt-5.2-codex\\"}"')

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
    expect(pi.slice(0, pi.indexOf('node '))).toBe('')

    // All are embedded in a single-quoted respawn-window.
    for (const cmd of [codex, opencode, pi]) expect(cmd).not.toContain("'")
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
      "refresh-client -B 'report-7:%7:#{=128;s/[^ -~]//:@yaac-model}|#{=32;s/[^A-Za-z-]//:@yaac-permission-mode}'")

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
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : \n')
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-opus-5-5[1m]\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', model: 'claude-opus-5-5[1m]' }],
    }))
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude', model: 'claude-sonnet-5' }],
    }))
    expect(agentSets().length).toBe(before + 2)

    // The mode arrives in claude's own terms; mapping it to a posture happens
    // elsewhere.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5|acceptEdits\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: '%7', tool: 'claude', model: 'claude-sonnet-5', reportedMode: 'acceptEdits' }],
    }))
    // An unchanged push is ignored; an empty half keeps the last value.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5|\n')
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
      "list-panes -s -F '#{pane_id}\t#{window_name}\t#{m/r:^\"?sleep infinity\"?$,#{pane_start_command}}\t#{=1024;s/[^ -~]//:@yaac-session}' -t yaac")
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
    await answer(stream, "refresh-client -B 'boot-7:%7:#{m/r:^\"?sleep infinity\"?$,#{pane_start_command}}'")
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
    // No fs/terminal capabilities: the agent has the real files itself.
    expect((init.params as { clientCapabilities: unknown }).clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
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
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'status', handle: 'claude', status: 'waiting' }))

    expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end'])
    expect(events[1]).toMatchObject({ stopReason: 'end_turn' })
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

    // Busy at the protocol level, but shown as waiting everywhere.
    await vi.waitFor(() => expect(conversation.status).toBe('waiting'))
    expect(statuses(seen).at(-1)).toBe('waiting')

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
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('waiting'))

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
    // The launch knows the provider default; the handshake delivers it.
    agentDriver('acp').launchCmd({
      tool: 'pi',
      agentSessionId: 'wt-1',
      resume: false,
      windowName: 'pi',
      paths: workspacePathsFixture(),
      permissionMode: 'bypass',
    })
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

    // Via the `model` config option; pi-acp does not implement `session/set_model`.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(true))
    const setModel = stream.sent().find((m) => m.method === 'session/set_config_option')!
    expect(setModel.params).toEqual({ sessionId: 'pi-1', configId: 'model', value: PI_DEFAULT_MODEL })
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
    ).toBe('waiting'))
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

  it('reports a mode the adapter REFUSED, which is where a codex workspace runs loose', async () => {
    // codex-acp's default `agent` mode is looser than `accept-edits`, so a
    // refused `session/set_mode` must be reported to the pane.
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

    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    const message = (events.find((e) => e.type === 'error') as { message: string }).message
    expect(message).toContain('workspace-write')
    // Names the mode actually in effect.
    expect(message).toContain('agent')
    // The conversation survives.
    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined()
  })

  it('gives up on a reattach it cannot address rather than talking to the wrong session', async () => {
    const stream = new FakeStream()
    tmuxWindows = 'claude\n'
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: acpDial(() => stream), log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    // Already initialized, but no recorded session id to address it by, so
    // tear down and let the next sweep retry.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
    await vi.waitFor(() => {
      expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeUndefined()
    })
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

  it('re-dials a window whose acpd has not bound its socket yet', async () => {
    const streams: FakeStream[] = []
    tmuxWindows = 'claude\n'
    connections.push(agentDriver('acp').connect(session, () => {}, {
      // A long settled interval, so only the fast retry after a drop can make
      // the second dial happen in time.
      heartbeatIntervalMs: 60_000,
      log: () => {},
      dial: acpDial(() => {
        const stream = new FakeStream()
        streams.push(stream)
        // The first dial into a new window often beats acpd's bind and closes.
        if (streams.length === 1) setTimeout(() => stream.emitExit(), 0)
        return stream
      }),
    }))

    await vi.waitFor(() => expect(streams.length).toBe(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
  })

  // tmux pushes window adds, and a respawn into the placeholder fires its
  // boot subscription, so neither waits for the heartbeat or costs an exec.
  it('dials a new window and a respawned placeholder as tmux announces them', async () => {
    const dialed: string[] = []
    tmuxWindows = 'claude\n'
    placeholders.add('claude')
    connections.push(agentDriver('acp').connect(session, () => {}, {
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
      expect(cmd).toContain('setsid sh /tmp/.yaac-prompt.sh >/tmp/yaac-prompt.log 2>&1 </dev/null &')
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

    it('carries any text to the pane intact, as a bracketed paste', async () => {
      const nasty = 'say "hi" && don\'t eval `$HOME`\nsecond line — ünïcode'
      const script = await deliveredScript(nasty)
      expect(script).not.toContain('$HOME')
      const b64 = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| tmux[^|]*load-buffer/.exec(script)?.[1]
      expect(Buffer.from(b64!, 'base64').toString('utf8')).toBe(nasty)
      expect(script).toContain('paste-buffer -p -d -b yaac-prompt -t %3')
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
      expect(script).toContain('paste-buffer -p -d -b yaac-prompt -t %3')
    })
  })
})
