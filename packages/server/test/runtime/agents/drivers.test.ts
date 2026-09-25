import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir, codexDir } from '@yaac/shared/project-paths'
import { agentDriver, type AgentObservation, type DrivenWorktree } from '#runtime/agents/drivers'
// A bound, imported rather than duplicated: a test that hard-codes the budget
// passes against a driver that changed it.
import { MAX_FAST_ATTACH_ATTEMPTS } from '#runtime/agents/acp-driver'
import {
  _resetAcpRegistryForTests,
  acpConversation,
  acpConversationByHandle,
} from '#runtime/agents/acp-registry'
import { installFakeWorktreeDriver, workspacePathsFixture } from '@yaac/test-utils/fake-driver'
import type { StreamChild, WorktreeDriver } from '#drivers/contract'
import type { AcpConversation } from '#runtime/agents/acp-client'
import type { AcpEventInit } from '@yaac/shared/acp'
import {
  ACP_SUPPORTED_PERMISSION_MODES,
  AGENT_TOOLS,
  SUPPORTED_PERMISSION_MODES,
} from '@yaac/shared/types'
import { _ACP_PROFILES } from '#runtime/agents/acp-adapters'
import type { PermissionMode } from '@yaac/shared/types'
import { PI_DEFAULT_PROVIDER, piProviderInfo } from '@yaac/shared/tool-providers'

/** What a pi conversation runs when the create named no model: the
 *  authenticated provider's own default, which is also what picks the api-key
 *  the egress proxy swaps. */
const PI_DEFAULT_MODEL = piProviderInfo(PI_DEFAULT_PROVIDER).defaultModel

/**
 * The driver seam, exercised the way the status watcher exercises it: connect,
 * feed the pod's side of the wire, and assert the observations that come back.
 *
 * Mocking is at the contract boundary only — the driver's dial and its
 * one-shot exec — so the real ControlModeClient, the real JSON-RPC peer, the
 * real ACP translation and the real conversation state machine all run. That is what
 * makes one test per mode enough to cover the protocol modules underneath
 * them; none of them is mocked out.
 */

const podExec = vi.fn<WorktreeDriver['exec']>()

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
  /** Deliver bytes as if the pod sent them. A relay stream hands over raw
   *  Buffers on TCP read boundaries, so tests that care about decoding pass
   *  Buffers; the rest pass strings for readability. */
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

const session: DrivenWorktree = {
  slug: 'demo',
  worktreeId: 'wt-1',
  jobName: 'yaac-demo-wt-1',
  tool: 'claude',
}

const connections: Array<{ close(): void }> = []

/**
 * Collect a conversation's events. The conversation retains nothing now — its
 * history is the record acpd writes — so a test that wants to assert on the
 * stream has to watch it.
 */
function collect(conversation: AcpConversation): AcpEventInit[] {
  const events: AcpEventInit[] = []
  conversation.subscribe((e) => events.push(e))
  return events
}

/**
 * Write the record acpd would have left for a conversation. A reattaching
 * connection has no other way to learn what the agent it just took over is
 * doing — see the reattach tests below — so a test about that has to put one
 * on disk.
 */
async function record(agentSessionId: string, lines: unknown[]): Promise<void> {
  const dir = acpLogDir(session.slug, session.worktreeId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${agentSessionId}.jsonl`),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
  )
}

/** acpd stamps every record with the life that wrote it. */
const lifeLine = {
  jsonrpc: '2.0',
  method: '_acpd/life',
  params: { id: 'life-1', startedAt: '2026-01-01T00:00:00.000Z' },
}

/** The record a handshake that left the session in `modeId` writes — what a
 *  real reattach always finds, and all it has to tell its posture by. */
const recordMode = (agentSessionId: string, modeId: string): Promise<void> => record(agentSessionId, [
  lifeLine,
  { jsonrpc: '2.0', id: 'h-1', method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } },
  { jsonrpc: '2.0', id: 'h-1', result: { sessionId: agentSessionId, modes: { currentModeId: modeId } } },
])

/** A prompt as the record holds it: the client's own request, carrying the id
 *  its reply will arrive under. */
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

/** A permission ask's params, in the shape the pinned claude adapter sends:
 *  the call being asked about, and one option per answer. */
const askParams = {
  sessionId: 'acp-1',
  toolCall: { toolCallId: 'call-1', title: 'rm -rf build', kind: 'execute' },
  options: [
    { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    { optionId: 'yes-always', name: 'Always Allow', kind: 'allow_always' },
  ],
}

/** The agent asking, as a line off the wire. */
const permissionAsk = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: askParams })}\n`

/**
 * A connection reattached to a live conversation under a given posture — the
 * state every permission test starts from, since an ask can only arrive at an
 * agent that is already running.
 */
async function attachedUnder(
  permissionMode: PermissionMode,
  agentSessionId: string,
): Promise<{ stream: FakeStream; seen: AgentObservation[] }> {
  const stream = new FakeStream()
  podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
  const seen: AgentObservation[] = []
  connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
    dial: () => stream,
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
  installFakeWorktreeDriver({ exec: podExec })
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
    // TUI: the tool's own binary, pinned to the conversation id.
    expect(agentDriver('tui').launchCmd(spec)).toContain('claude --permission-mode bypassPermissions')
    expect(agentDriver('tui').launchCmd(spec)).toContain('--session-id conv-1')

    // ACP: acpd supervising the adapter, with the socket named for the window
    // — that name is the conversation's handle everywhere else.
    const acp = agentDriver('acp').launchCmd(spec)
    expect(acp).toContain('node /opt/yaac/acpd/main.js')
    expect(acp).toContain('--sock /tmp/yaac-acp/claude-2.sock')
    expect(acp).toContain('-- claude-agent-acp')
    // The adapter's own cwd, named rather than inherited: acpd is shared by
    // both runtimes and cannot know where a checkout lives, and a wrong one
    // fails the spawn as if the binary were missing.
    expect(acp).toContain('--cwd /workspace')
    // The record is named for the CONVERSATION, not the window: a window name
    // is a slot, and a restart that drops an earlier conversation shifts the
    // others down a slot, which under slot-naming would truncate one
    // conversation's history onto another's file.
    expect(acp).toContain('--log /home/yaac/.yaac-acp/conv-1.jsonl')
    // Still no resume flag — resuming is `session/load`, a protocol call made
    // after connecting, not a launch argument.
    expect(acp).not.toContain('resume')
    // A single-quoted respawn-window wrapper carries it, so no quotes.
    expect(acp).not.toContain("'")
  })

  it('offers a mode id for exactly the postures create will let through', () => {
    // The two halves of a posture actually being honored. Create refuses a
    // posture outside the ACP column, and the adapter is told the mode id for
    // one that is in it — so a posture in the column with NO mode id has to be
    // carried some other way, and the profile is where that is said: opencode's
    // ride `OPENCODE_PERMISSION` at launch (asserted in the launch case below),
    // and pi has no permission system at all.
    //
    // The profiles are read here as a policy constant, not as a unit under
    // test: what drives them is the launch command and the handshakes in this
    // same describe.
    for (const tool of AGENT_TOOLS) {
      const withModeId = SUPPORTED_PERMISSION_MODES[tool].filter(
        (m) => _ACP_PROFILES[tool].modeIds[m] !== undefined,
      )
      // Never a mode id for a posture create would refuse: that would be one
      // reachable only by a caller who bypassed the refusal.
      const supported = ACP_SUPPORTED_PERMISSION_MODES[tool]
      expect(withModeId.filter((m) => !supported.includes(m)), tool).toEqual([])
    }
    // The carried-elsewhere cases, stated so a silent change to either table
    // has to be deliberate.
    expect(SUPPORTED_PERMISSION_MODES.claude.filter((m) => _ACP_PROFILES.claude.modeIds[m] === undefined))
      .toEqual([])
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

    // codex-acp takes no flags at all: a model is merged into the codex
    // session config through the environment, and the browser login is shut
    // off because nothing in a worktree could open one.
    const codex = spec('codex')
    expect(codex).toContain('NO_BROWSER=1 node /opt/yaac/acpd/main.js')
    expect(codex).toContain('-- codex-acp')
    expect(codex).not.toContain('CODEX_CONFIG')
    expect(spec('codex', { model: 'gpt-5.2-codex' }))
      .toContain('CODEX_CONFIG="{\\"model\\":\\"gpt-5.2-codex\\"}"')

    // opencode IS its own adapter, and its posture is the same config document
    // the TUI is launched with, built by the same function — one table, both
    // modes.
    const opencode = spec('opencode')
    expect(opencode).toContain('-- opencode acp')
    expect(opencode).toContain('OPENCODE_CONFIG_CONTENT=')
    expect(opencode).toContain('\\"effect\\":\\"allow\\"')
    expect(spec('opencode', { permissionMode: 'plan' })).toContain('\\"effect\\":\\"ask\\"')
    // No model in it, even when one was asked for: opencode's ACP path ignores
    // the config's `model`, so it is named over the protocol instead.
    expect(spec('opencode', { model: 'opencode/big-pickle' })).not.toContain('big-pickle')

    // pi-acp takes neither: its model is a protocol call after the handshake.
    const pi = spec('pi')
    expect(pi).toContain('-- pi-acp')
    expect(pi.slice(0, pi.indexOf('node '))).toBe('')

    // Every one of them still travels inside a single-quoted respawn-window
    // wrapper, so none may contain a quote of its own.
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

    // tmux's unsolicited attach banner, then the pane enumeration reply.
    stream.feed('%begin 1 100 0\n%end 1 100 0\n%session-changed $0 yaac\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))
    stream.feed('%begin 1 101 1\n%7 claude\n%end 1 101 1\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain("refresh-client -B 'status-7:%7:#{pane_title}'"))
    stream.feed('%begin 1 102 1\n%end 1 102 1\n')
    // A second subscription per pane follows what its tool reports: the model
    // option claude's hooks set the moment `/model` lands, and the permission
    // mode they set as a change takes hold — each filtered and bounded by tmux
    // itself, since anything in the workspace can set them and tmux would
    // otherwise pass a newline straight into this stream.
    await vi.waitFor(() => expect(stream.writes.join('')).toContain(
      "refresh-client -B 'report-7:%7:#{=128;s/[^ -~]//:@yaac-model}|#{=32;s/[^A-Za-z-]//:@yaac-permission-mode}'",
    ))
    stream.feed('%begin 1 103 1\n%end 1 103 1\n')

    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    // The conversation's handle is its pane id; which conversation sits on it
    // is the hook's session-starts log to answer, not this driver's.
    expect(seen).toContainEqual({ kind: 'live-agents', agents: [{ handle: '%7', tool: 'claude' }] })
    expect(seen.some((o) => o.kind === 'command-channel' && o.send !== null)).toBe(true)

    // A pushed subscription value is classified against the pane's own tool.
    stream.feed('%subscription-changed status-7 $0 @0 0 %7 : ⠋ working\n')
    expect(seen).toContainEqual({ kind: 'status', handle: '%7', status: 'running' })
    stream.feed('%subscription-changed status-7 $0 @0 0 %7 : ✳ done\n')
    expect(seen).toContainEqual({ kind: 'status', handle: '%7', status: 'waiting' })

    // Nothing reported yet is not a model; a report, and then a switch, each
    // republish the live set with it.
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

    // The mode rides the same push, in claude's own words — which posture it
    // stands for is decided where the worktree's row is, not here.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5|acceptEdits\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: '%7', tool: 'claude', model: 'claude-sonnet-5', reportedMode: 'acceptEdits' }],
    }))
    // An unchanged push is not a change, and an empty half leaves the last
    // report standing.
    stream.feed('%subscription-changed report-7 $0 @0 0 %7 : claude-sonnet-5|\n')
    expect(agentSets().length).toBe(before + 3)
  })

  it("follows a codex pane's model and conversation through its title", async () => {
    // codex can run nothing on a model switch, but it retitles the pane: the
    // format cuts the model's display name out of the title, and codex's own
    // cached catalog maps it back to the slug the rest of yaac speaks.
    const stream = new FakeStream()
    const seen: AgentObservation[] = []
    connections.push(agentDriver('tui').connect({ ...session, tool: 'codex' }, (o) => seen.push(o), {
      dial: () => stream, heartbeatIntervalMs: 60_000, commandTimeoutMs: 1_000, log: () => {},
    }))
    stream.feed('%begin 1 100 0\n%end 1 100 0\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('list-panes'))
    stream.feed('%begin 1 101 1\n%2 codex\n%end 1 101 1\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain("refresh-client -B 'status-2:"))
    stream.feed('%begin 1 102 1\n%end 1 102 1\n')
    await vi.waitFor(() => expect(stream.writes.join('')).toContain("refresh-client -B 'report-2:%2:#{?#{m/r: [|] ,"))
    stream.feed('%begin 1 103 1\n%end 1 103 1\n')
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))

    // No cache — api-key auth and a failed fetch never write one — but the
    // title still shows a display name from codex's bundled catalog, so the
    // catalogs' own spelling rule stands in.
    stream.feed('%subscription-changed report-2 $0 @0 0 %2 : GPT-6-Astra\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%2', tool: 'codex', model: 'gpt-6-astra' }],
    }))

    // With one, the cache is asked first — for a name the rule would get wrong.
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
    // A model the catalog does not list is titled by its slug already.
    stream.feed('%subscription-changed report-2 $0 @0 0 %2 : my-made-up-model\n')
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents', agents: [{ handle: '%2', tool: 'codex', model: 'my-made-up-model' }],
    }))

    // The title also names the conversation, cut short as codex 0.156.1 cuts
    // it — what joins the pane to its conversation where no hook says. A turn
    // trails it with a spinner; a title naming none yet leaves the last one
    // standing; a `/new` moves it.
    const title = (value: string): void => stream.feed(`%subscription-changed status-2 $0 @0 0 %2 : ${value}\n`)
    const named = (): Array<string | undefined> => [...new Set(seen.flatMap((o) =>
      o.kind === 'live-agents' ? o.agents.map((a) => a.sessionIdPrefix) : []))]
    title('workspace | my-made-up-model')
    title('workspace | 01a0d8bb-6d78-7cb3-a16e-7e254... | my-made-up-model')
    title('⠙ workspace | 01a0d8bb-6d78-7cb3-a16e-7e254... ⠙ | my-made-up-model')
    expect(seen.at(-1)).toEqual({ kind: 'status', handle: '%2', status: 'running' })
    title('workspace | my-made-up-model')
    title('workspace | 01a0d8bb-e717-7eb3-8acf-62542... | my-made-up-model')
    expect(named()).toEqual([undefined, '01a0d8bb-6d78-7cb3-a16e-7e254', '01a0d8bb-e717-7eb3-8acf-62542'])
    expect(seen.at(-1)).toEqual({
      kind: 'live-agents',
      agents: [{ handle: '%2', tool: 'codex', sessionIdPrefix: '01a0d8bb-e717-7eb3-8acf-62542', model: 'my-made-up-model' }],
    })
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
    // Retry policy is the watcher's; the driver only reports the fact.
    expect(seen.some((o) => o.kind === 'down')).toBe(true)
    expect(seen.at(-2)).toEqual({ kind: 'command-channel', send: null })
  })

  it('drives an acp conversation end to end: handshake, updates, status, prompt', async () => {
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\ninit\n', stderr: '' })
    const seen: AgentObservation[] = []
    const driver = agentDriver('acp')
    connections.push(driver.connect(session, (o) => seen.push(o), {
      dial: () => stream, commandTimeoutMs: 1_000, log: () => {},
    }))

    // The window enumeration is the health probe; only agent windows count
    // (`init` is an init-command window, not a conversation).
    await vi.waitFor(() => expect(seen.some((o) => o.kind === 'up')).toBe(true))
    // The driver writes nothing until acpd greets it, so "attached" is the
    // registry entry appearing — under its handle, since no id exists yet.
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    // acpd's greeting starts the handshake.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'initialize')).toBe(true))

    const init = stream.sent().find((m) => m.method === 'initialize')!
    // yaac declines fs/terminal: the agent is in the container, on the real
    // /workspace, and serves itself.
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
      result: { sessionId: 'acp-1', configOptions: [{ id: 'model', currentValue: 'claude-opus-5' }] },
    })}\n`)

    // The conversation id the agent minted is published — this is what the
    // registry records, replacing the TUI mode's hook and its log entirely —
    // and so is the model the reply said the session opened with.
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-1', model: 'claude-opus-5' }],
    }))

    const events = collect(acpConversation('demo', 'wt-1', 'acp-1')!)
    // A prompt turn: status is exact, not scraped from a spinner.
    await driver.deliverPrompt(session, 'claude', 'hello there')
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'status', handle: 'claude', status: 'running' }))
    const prompt = stream.sent().find((m) => m.method === 'session/prompt')!
    expect(prompt.params).toEqual({ sessionId: 'acp-1', prompt: [{ type: 'text', text: 'hello there' }] })

    // Agent output is deliberately NOT observed here: `session/update`
    // notifications reach a pane through acpd's record, not this socket, so a
    // conversation emits only what the record cannot carry — the turn
    // boundaries. What the record produces is covered in acp-log.test.ts.
    const update = (u: unknown): string =>
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: u } })}\n`
    stream.feed(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } }))
    // A switch mid-conversation (a `/model` typed into the chat) is pushed the
    // moment the adapter reports it, with no answer from the new model needed.
    stream.feed(update({
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'mode', currentValue: 'default' }, { id: 'model', currentValue: 'claude-fable-5' }],
    }))
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-1', model: 'claude-fable-5' }],
    }))

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'status', handle: 'claude', status: 'waiting' }))

    expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end'])
    expect(events[1]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('resumes a recorded acp conversation with session/load instead of a new one', async () => {
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
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

    // The reply names the model the session holds — here in the `models`
    // shape — and that is published with the conversation.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: load.id, result: { models: { currentModelId: 'claude-fable-5' } } })}\n`)
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-old', model: 'claude-fable-5' }],
    }))
  })

  it('skips the handshake when reattaching to an agent that is already running', async () => {
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    // acpd says this agent has already spoken to someone: re-running
    // `initialize` against a live process is undefined, so nothing is sent.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    await new Promise((r) => setTimeout(r, 50))
    expect(stream.sent().some((m) => m.method === 'initialize')).toBe(false)
    expect(stream.sent().some((m) => m.method === 'session/new')).toBe(false)
  })

  it('recovers a turn the previous connection started, and ends it on the orphan reply', async () => {
    // The agent outlives the connection watching it, so a reattach — after a
    // relay drop, a streamd self-heal, a server restart — can land mid-turn.
    // ACP cannot say so: a turn is running iff YOUR `session/prompt` is
    // unanswered, and this connection sent none. acpd's record is the only
    // thing that knows, because it holds both directions of the dialogue.
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
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-live')!
    // Subscribed before the greeting, which is where a pane that stayed open
    // across the drop sits: it must not miss the boundary it never sent.
    const events = collect(conversation)

    stream.feed(helloLine(false))

    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'status', handle: 'claude', status: 'running',
    }))
    // Nothing was guessed in the meantime. A sweep publishing `waiting` for a
    // conversation that had not classified itself is what painted a working
    // agent idle — every 20s, for as long as the turn ran.
    expect(statuses(seen)).toEqual(['running'])
    // A pane has no `user` event of its own for this turn, so the turn
    // beginning has to be announced rather than inferred.
    expect(events.map((e) => e.type)).toEqual(['turn-start'])

    // And the recovered turn is interruptible: cancel guards on the
    // conversation believing itself busy, so it used to be a silent no-op here.
    conversation.cancel()
    expect(stream.sent().some((m) => m.method === 'session/cancel')).toBe(true)

    // The reply carries the dead connection's request id, so it arrives as an
    // orphan — which is what ends the turn recovery started.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'status', handle: 'claude', status: 'waiting',
    }))
    expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end'])
  })

  it('classifies a reattach as waiting when the record shows the turn was answered', async () => {
    // The reply can land while nothing is attached — acpd holds nothing for an
    // absent client — in which case no orphan ever arrives and the record is
    // the only evidence the turn finished.
    await record('acp-done', [
      lifeLine,
      promptLine('acp-done', 'old-1', 'what changed?'),
      { jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } },
    ])
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-done' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-done')).toBeDefined())
    stream.feed(helloLine(false))

    // Still classified, rather than left unclassified forever: an idle
    // conversation nobody publishes is one the sidebar cannot show either.
    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))
  })

  it('reads a turn whose agent died as ended, not as still running', async () => {
    // The bound on "last prompt unanswered ⇒ in flight": a turn whose agent
    // exited has no reply and never will, so without acpd's exit line the scan
    // would pin the conversation `running` with nothing left to release it.
    await record('acp-dead', [
      lifeLine,
      promptLine('acp-dead', 'old-1', 'do the thing'),
      { jsonrpc: '2.0', method: '_acpd/exit', params: { code: 1, signal: null } },
    ])
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-dead' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-dead')).toBeDefined())
    stream.feed(helloLine(false))

    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))
  })

  it('holds a prompt sent straight after a reattach behind the turn it recovered', async () => {
    // The recovered turn is running at the adapter but was never put in the
    // queue — nothing in this connection started it. Dispatching over it would
    // overlap two turns at an adapter that assumes one, and the first reply
    // back would end the wrong one.
    await record('acp-live', [lifeLine, promptLine('acp-live', 'old-1', 'the running turn')])
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-live')!
    stream.feed(helloLine(false))
    await vi.waitFor(() => expect(conversation.isBusy).toBe(true))

    void conversation.prompt('and now this').catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(false)

    // The orphan ends the recovered turn, which is what releases the queue.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))
    expect((stream.sent().find((m) => m.method === 'session/prompt')!
      .params as { prompt: Array<{ text: string }> }).prompt[0].text).toBe('and now this')
  })

  it('lets a reply that beats the record scan settle the status, rather than stranding it busy', async () => {
    // Recovery is a file read, so anything that resolves the status first knows
    // something newer than the record does. A late `true` overwriting it would
    // pin a conversation busy with no event left to release it.
    await record('acp-live', [lifeLine, promptLine('acp-live', 'old-1', 'go')])
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-live' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-live')).toBeDefined())

    stream.feed(helloLine(false))
    // Same tick as the greeting: the scan cannot have answered yet, because it
    // has not been off the event loop.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 'old-1', result: { stopReason: 'end_turn' } })}\n`)

    await vi.waitFor(() => expect(statuses(seen)).toEqual(['waiting']))
    // Long enough for the scan to come back and be ignored.
    await new Promise((r) => setTimeout(r, 50))
    expect(statuses(seen)).toEqual(['waiting'])
  })

  it('grants tool permission rather than prompting under bypass, matching the sandbox posture', async () => {
    await recordMode('acp-1', 'bypassPermissions')
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      // A reattach needs the recorded id: without one the conversation cannot
      // be addressed at all and the driver tears it down (covered below).
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    stream.feed(permissionAsk(99))

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 99)).toBe(true))
    // allow_always over allow_once: a session behind gVisor and an egress
    // allowlist is constrained by the sandbox, not by a prompt nobody sees.
    expect(stream.sent().find((m) => m.id === 99)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
  })

  /**
   * The heart of an enforced posture: the ask is held open, the conversation
   * says it is waiting on a person rather than working, and the answer that
   * finally comes back is the user's.
   */
  it('parks a permission ask for the user under a posture that is not bypass', async () => {
    const { stream, seen } = await attachedUnder('accept-edits', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!

    stream.feed(permissionAsk(99))
    // Nothing is answered on the agent's behalf — that is the whole posture.
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 99)).toBe(false)

    // A blocked turn is `busy` at the protocol level but is not working, and
    // the sidebar dot, the chime and the tray badge all read this one field.
    await vi.waitFor(() => expect(conversation.status).toBe('waiting'))
    expect(statuses(seen).at(-1)).toBe('waiting')

    conversation.answerPermission('99', 'no')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 99)).toBe(true))
    expect(stream.sent().find((m) => m.id === 99)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  /** A `session/update` notification, as a line off the wire. */
  const updateLine = (agentSessionId: string, update: Record<string, unknown>): string =>
    `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: agentSessionId, update } })}\n`

  /** Every mode the connection published on its live set, in order. */
  const reportedModes = (seen: AgentObservation[]): string[] => seen.flatMap((o) =>
    o.kind === 'live-agents' ? o.agents.flatMap((a) => (a.reportedMode !== undefined ? [a.reportedMode] : [])) : [])

  /**
   * An adapter can move a session by itself — claude's announces EnterPlanMode
   * and a plan-exit answer as a `current_mode_update` — and the mode it is in
   * from then on is what it answers asks by, and what the worktree's row is
   * told about.
   */
  it('publishes a mode the adapter moves to, and answers its asks by it', async () => {
    const { stream, seen } = await attachedUnder('bypass', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!

    stream.feed(updateLine('acp-1', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }))
    await vi.waitFor(() => expect(reportedModes(seen).at(-1)).toBe('plan'))

    // The row said bypass, but this session is in plan mode now: its ask to
    // leave it is the user's to answer.
    stream.feed(permissionAsk(99))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 99)).toBe(false)
  })

  // A plan-exit ask's options ARE mode ids: "yes, and bypass permissions"
  // moves the session up, and from then on this conversation answers its asks
  // the way the adapter now runs.
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

  // A reattach runs no handshake, so the mode its session is in is the one its
  // own record last shows — possibly moved while no server was listening. It
  // answers by that, whichever way it differs from the row, and reports it so
  // the row catches up.
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

    // A record whose mode stands for no posture leaves nothing to answer by —
    // and the row is no stand-in, since it may hold ANOTHER conversation's
    // raise. So every ask is the person's.
    await recordMode('acp-3', 'build')
    const unknown = await attachedUnder('bypass', 'acp-3')
    unknown.stream.feed(permissionAsk(9))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-3')!.isAwaitingPermission).toBe(true))
    expect(unknown.stream.sent().some((m) => m.id === 9)).toBe(false)
  })

  // opencode's modes are agents, not postures, so an opencode conversation
  // answers by the posture it launched in — read at launch. The row it came
  // from moves with every other conversation in the worktree, and one taking
  // "yes, and bypass permissions" must not start answering this one's asks.
  it('answers by the posture it launched in where its mode names none', async () => {
    const stream = new FakeStream()
    let row: PermissionMode = 'accept-edits'
    let reads = 0
    podExec.mockResolvedValue({ stdout: 'opencode\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      permissionMode: () => { reads++; return Promise.resolve(row) },
      heartbeatIntervalMs: 20,
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

    // Another conversation's raise lands on the row, and a sweep picks it up.
    row = 'bypass'
    const before = reads
    await vi.waitFor(() => expect(reads).toBeGreaterThan(before + 1))
    stream.feed(permissionAsk(4))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-oc')!.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 4)).toBe(false)
  })

  it('reads a mode change reported as a config option, which is how codex-acp says it', async () => {
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'codex\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
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

  /**
   * The posture an ask is answered by belongs to the conversation, not the
   * worktree: each adapter holds its own mode, so one conversation entering
   * plan mode says nothing about another still bypassing permissions.
   */
  it('keeps each conversation on its own posture', async () => {
    await recordMode('acp-a', 'bypassPermissions')
    await recordMode('acp-b', 'bypassPermissions')
    const streams = new Map([['claude', new FakeStream()], ['claude-2', new FakeStream()]])
    podExec.mockResolvedValue({ stdout: 'claude\nclaude-2\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: (_s, argv) => streams.get([...streams.keys()].find((h) => argv.join(' ').includes(`${h}.sock`))!)!,
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
    // The other conversation's adapter still bypasses permissions, so its ask
    // is answered for the user as before.
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

    // Two panes can hold the same card; the loser's click must not become a
    // second reply to an agent that has already moved on.
    conversation.answerPermission('7', 'yes-always')
    await new Promise((r) => setTimeout(r, 20))
    expect(stream.sent().filter((m) => m.id === 7)).toHaveLength(1)
  })

  it('releases a parked ask when the turn is cancelled, rather than stranding the promise', async () => {
    const { stream } = await attachedUnder('manual', 'acp-1')
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    // A turn has to be running for `cancel` to do anything.
    void conversation.prompt('go').catch(() => {})
    await vi.waitFor(() => expect(conversation.isBusy).toBe(true))
    stream.feed(permissionAsk(11))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))

    conversation.cancel()

    // ACP puts resolving outstanding asks on the client when it cancels. The
    // parked promise is a request the peer is awaiting a handler for, so
    // leaving it would strand both the agent and the served request.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 11)).toBe(true))
    expect(stream.sent().find((m) => m.id === 11)!.result)
      .toEqual({ outcome: { outcome: 'cancelled' } })
    expect(stream.sent().some((m) => m.method === 'session/cancel')).toBe(true)
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  it('answers an ask that arrived before a reconnect, rather than stranding the agent', async () => {
    // acpd buffers nothing for an absent client, so an ask delivered to the
    // previous connection is not replayed to this one. The record is the only
    // evidence it happened, and the agent's own id is what makes it answerable
    // from a connection that never received it.
    await record('acp-held', [
      lifeLine,
      promptLine('acp-held', 'old-1', 'do the thing'),
      { jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: askParams },
    ])
    const { stream, seen } = await attachedUnder('manual', 'acp-held')
    const conversation = acpConversation('demo', 'wt-1', 'acp-held')!

    // Recovered from the record: waiting on a person, not working.
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    await vi.waitFor(() => expect(statuses(seen).at(-1)).toBe('waiting'))

    conversation.answerPermission('42', 'yes-always')
    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 42)).toBe(true))
    expect(stream.sent().find((m) => m.id === 42)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  it('lands an answer clicked before recovery knew which ask it was for', async () => {
    // The registry publishes a conversation the moment it is built, and a
    // reattaching pane replays the pending card straight from the record — but
    // recovery only names the outstanding asks after acpd's greeting and two
    // file reads. A click in that window has a real ask behind it, and
    // discarding it would leave the agent blocked with a dead card until the
    // worktree restarted.
    await record('acp-held', [
      lifeLine,
      promptLine('acp-held', 'old-1', 'do the thing'),
      { jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: askParams },
    ])
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-held' }]),
      permissionMode: () => Promise.resolve('manual'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-held')).toBeDefined())
    const conversation = acpConversation('demo', 'wt-1', 'acp-held')!

    // Answered BEFORE the greeting that starts recovery — the window itself.
    conversation.answerPermission('42', 'yes-always')
    stream.feed(helloLine(false))

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 42)).toBe(true))
    expect(stream.sent().find((m) => m.id === 42)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
    expect(conversation.isAwaitingPermission).toBe(false)
  })

  it('forwards an ask when the posture could not be read, rather than granting it', async () => {
    // The asymmetry the whole feature turns on: a needless prompt costs a
    // click, a needless approval is silent and irreversible. So "not known
    // yet" — a failed row read, or no row — must never reach the auto-answer.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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

    // Forwarding asks decides who answers; the mode decides which questions
    // get asked at all, so a posture that never reaches the adapter is not
    // being enforced.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(true))
    expect(stream.sent().find((m) => m.method === 'session/set_mode')!.params)
      .toEqual({ sessionId: 'acp-1', modeId: 'plan' })
  })

  it('reads an adapter that announces its modes as config options, not a modes block', async () => {
    // opencode v2 answers `session/new` with `configOptions` only — a `mode`
    // select whose option values are its agent ids — and no `modes` block at
    // all. Reading one shape would leave a `plan` create in `build`: the gate
    // would find nothing advertised, skip `session/set_mode`, and post a
    // standing notice where the restraint should be. The ask-to-act rules from
    // the launch config would still apply, but not the plan agent's `edit
    // deny`, so the worktree would be editable.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'opencode\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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
    // The guard that makes the case above meaningful: a posture whose mode the
    // adapter already holds sends nothing, so a record with no
    // `session/set_mode` is not evidence that a posture was dropped.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'opencode\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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
    // pi's adapter has no `--model`, and pi's model id names its PROVIDER —
    // which decides the api-key the egress proxy swaps. A pi conversation that
    // never sends one authenticates against whatever pi's shared settings hold.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'pi\n', stderr: '' })
    // The launch is what knows the worktree's provider default; the handshake
    // is where it can be delivered.
    agentDriver('acp').launchCmd({
      tool: 'pi',
      agentSessionId: 'wt-1',
      resume: false,
      windowName: 'pi',
      paths: workspacePathsFixture(),
      permissionMode: 'bypass',
    })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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

    // As the `model` config option: pi-acp's `session/set_model` is not routed,
    // and answers "Method not found".
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_config_option')).toBe(true))
    const setModel = stream.sent().find((m) => m.method === 'session/set_config_option')!
    expect(setModel.params).toEqual({ sessionId: 'pi-1', configId: 'model', value: PI_DEFAULT_MODEL })
    expect(stream.sent().some((m) => m.method === 'session/set_model')).toBe(false)
    // pi advertises thinking levels rather than postures, so there is no mode
    // for `bypass` to be — and sending one would be rejected outright.
    expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(false)

    // A model the adapter will not take is survived and said out loud: the
    // conversation runs the adapter's own default, which for pi means a
    // provider whose api key the egress proxy never swapped — a worktree that
    // fails at its first turn for a reason nothing else would explain.
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
    // pi has no permission system: what arrives on `session/request_permission`
    // are its extensions' own questions, so auto-answering would answer FOR the
    // user rather than spare them a prompt they waived.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'pi\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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
    // Nothing answers it: the conversation holds the request open for a person,
    // which is what its status says.
    await vi.waitFor(() => expect(
      acpConversationByHandle('demo', 'wt-1', 'pi')!.status,
    ).toBe('waiting'))
    expect(stream.sent().some((m) => m.id === 501)).toBe(false)
  })

  it('reports a mode it could not set to the pane, and keeps the conversation', async () => {
    // `bypassPermissions` is withheld by an adapter running as root outside a
    // sandbox, and `auto` by a model with no classifier. Setting one throws at
    // the adapter, and losing the conversation over it would be worse than
    // running in its default — which is then the conversation's posture, and
    // the worktree's.
    //
    // But it is NOT silent. An adapter's default is not always at least as
    // strict as what was asked (codex-acp's is `agent`, where a reviewer model
    // approves most actions), so a conversation running in one has to say so
    // where the person who chose the posture will see it: the pane.
    const stream = new FakeStream()
    const events: AcpEventInit[] = []
    const seen: AgentObservation[] = []
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      permissionMode: () => Promise.resolve('bypass'),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    // Subscribed before the handshake runs, because the report is part of it.
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

    // The pane is told which mode it is actually in — and only that. What
    // happens to the asks from here varies (bypass answers them itself, and
    // codex's fallback has a reviewer model answering most), so the message
    // deliberately promises nothing about them.
    const reported = events.filter((e) => e.type === 'error')
    expect(reported.length).toBe(1)
    expect((reported[0] as { message: string }).message).toContain('bypassPermissions')
    expect((reported[0] as { message: string }).message).toContain('default')
    expect((reported[0] as { message: string }).message).not.toContain('forwarded')

    // And the conversation still works — in the mode it is actually in, which
    // is reported upward and answers its asks: `default` asks the person.
    await vi.waitFor(() => expect(reportedModes(seen).at(-1)).toBe('default'))
    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    stream.feed(permissionAsk(3))
    await vi.waitFor(() => expect(conversation.isAwaitingPermission).toBe(true))
    expect(stream.sent().some((m) => m.id === 3)).toBe(false)
  })

  it('reports a mode the adapter REFUSED, which is where a codex worktree runs loose', async () => {
    // The exposed cell, and the reason this path reports rather than only
    // logs: codex-acp's own default is `agent` — a reviewer model approving
    // most actions — not the codex CLI's `read-only` preset. So an
    // `accept-edits` conversation whose `session/set_mode` is refused runs
    // LOOSER than the create asked for, and the log is not where the person
    // who asked is looking.
    const stream = new FakeStream()
    const events: AcpEventInit[] = []
    podExec.mockResolvedValue({ stdout: 'codex\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
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
          availableModes: [{ id: 'read-only' }, { id: 'agent' }, { id: 'agent-full-access' }],
        },
      },
    })}\n`)

    // Advertised, so it is asked for — and refused.
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/set_mode')).toBe(true))
    const setMode = stream.sent().find((m) => m.method === 'session/set_mode')!
    expect(setMode.params).toEqual({ sessionId: 'acp-1', modeId: 'read-only' })
    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: setMode.id, error: { code: -32603, message: 'mode unavailable' },
    })}\n`)

    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    const message = (events.find((e) => e.type === 'error') as { message: string }).message
    expect(message).toContain('read-only')
    // Names the mode it is actually in, which is the whole point: `agent` is
    // not what was asked for and not stricter than it.
    expect(message).toContain('agent')
    // The conversation survives it — losing a worktree over a posture would be
    // worse than running in the adapter's default and saying so.
    expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined()
  })

  it('gives up on a reattach it cannot address rather than talking to the wrong session', async () => {
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream, log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())

    // acpd says the agent already handshook, but nothing recorded which
    // conversation it holds — so every `session/prompt` would name a session
    // id we do not have. Tearing down lets the next sweep retry.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
    await vi.waitFor(() => {
      expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeUndefined()
    })
  })

  it('re-dials a window whose acpd has not bound its socket yet', async () => {
    const streams: FakeStream[] = []
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      // The settled cadence, set far beyond this test's patience: a re-dial
      // that waited for it would leave a fresh ACP worktree showing acpd's
      // log instead of a chat pane for a full sweep, which is the bug this
      // covers. The first sweep DOES lower the cadence to this — the window
      // is there and the dial did not throw — so nothing but the drop itself
      // can put the connection back on the fast one.
      heartbeatIntervalMs: 60_000,
      log: () => {},
      dial: () => {
        const stream = new FakeStream()
        streams.push(stream)
        // tmux spawns acpd a moment before acpd binds, so the first dial into
        // a brand-new window usually finds nothing listening: socat exits and
        // the stream closes. The second finds a live socket.
        if (streams.length === 1) setTimeout(() => stream.emitExit(), 0)
        return stream
      },
    }))

    await vi.waitFor(() => expect(streams.length).toBe(2), { timeout: 5_000 })
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
  })

  it('stops re-dialing a window that can never hold an attach', async () => {
    const streams: FakeStream[] = []
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    vi.useFakeTimers()
    try {
      connections.push(agentDriver('acp').connect(session, () => {}, {
        // Far apart, so the two cadences are unambiguous in the counts below.
        heartbeatIntervalMs: 600_000,
        log: () => {},
        dial: () => {
          // acpd is gone but tmux kept its window: every dial finds nothing
          // and exits, forever. Fast retries must not be forever with it.
          const stream = new FakeStream()
          streams.push(stream)
          setTimeout(() => stream.emitExit(), 0)
          return stream
        },
      }))

      // The fast attempts are spent and then stop, rather than costing an exec
      // and a dial every second for the life of the pod.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(streams.length).toBe(MAX_FAST_ATTACH_ATTEMPTS)

      // Given up on the fast cadence, NOT on the window: a settled sweep still
      // re-dials it, so an acpd that comes back is picked up.
      await vi.advanceTimersByTimeAsync(600_000)
      expect(streams.length).toBe(MAX_FAST_ATTACH_ATTEMPTS + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('decodes a multi-byte character split across two socket reads', async () => {
    await recordMode('acp-1', 'bypassPermissions')
    // The relay delivers raw Buffers on TCP read boundaries, which land
    // wherever the network puts them. Decoded per chunk, a character split
    // across two reads becomes replacement characters in both halves — and
    // because the split can only fall inside a JSON string, the line still
    // parses and the corruption is silent.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    // A permission request, which the client must parse to answer — so a
    // mangled line shows up as a question that never gets a reply.
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

  it('queues a second prompt instead of overlapping turns', async () => {
    // ACP adapters assume one turn at a time, and nothing upstream enforces
    // it — an Enter mid-turn reaches the conversation. Overlapping would also
    // corrupt its own bookkeeping: the FIRST reply would end the turn while
    // the second still streamed, reporting `waiting` for a working agent.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    void conversation.prompt('first').catch(() => {})
    void conversation.prompt('second').catch(() => {})
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))

    // One turn on the wire at a time. The user's own messages are not asserted
    // here — they reach a pane through acpd's record, which orders them by
    // when each request was actually sent.
    expect(stream.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(1)

    const first = stream.sent().find((m) => m.method === 'session/prompt')!
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: first.id, result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => {
      expect(stream.sent().filter((m) => m.method === 'session/prompt')).toHaveLength(2)
    })
    expect((stream.sent().filter((m) => m.method === 'session/prompt')[1].params as { prompt: Array<{ text: string }> }).prompt[0].text)
      .toBe('second')
  })

  it('drops a duplicate reply instead of ending the turn it is not about', async () => {
    // Only a FOREIGN id is a cross-connection orphan meaning "the previous
    // turn ended". An unknown id carrying this connection's own prefix is a
    // duplicate of something already resolved, and reading it as a turn end
    // would mark a live turn finished while the agent keeps streaming.
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    const seen: AgentObservation[] = []
    connections.push(agentDriver('acp').connect(session, (o) => seen.push(o), {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    const conversation = acpConversation('demo', 'wt-1', 'acp-1')!
    void conversation.prompt('go').catch(() => {})
    await vi.waitFor(() => expect(stream.sent().some((m) => m.method === 'session/prompt')).toBe(true))
    const sent = stream.sent().find((m) => m.method === 'session/prompt')!

    // A second copy of a reply this connection already resolved.
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(conversation.isBusy).toBe(false))
    void conversation.prompt('next').catch(() => {})
    await vi.waitFor(() => expect(conversation.isBusy).toBe(true))

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } })}\n`)
    await new Promise((r) => setTimeout(r, 30))
    // The duplicate named the FIRST turn; the second is still running.
    expect(conversation.isBusy).toBe(true)
  })

  it('survives a non-JSON line from the adapter instead of killing the conversation', async () => {
    await recordMode('acp-1', 'bypassPermissions')
    const stream = new FakeStream()
    podExec.mockResolvedValue({ stdout: 'claude\n', stderr: '' })
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())

    // An adapter that prints a banner to stdout must not take the
    // conversation down with it — the peer still answers what comes after.
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
})
