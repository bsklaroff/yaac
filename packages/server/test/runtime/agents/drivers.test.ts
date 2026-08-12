import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir } from '@yaac/shared/project-paths'
import { agentDriver, type AgentObservation, type DrivenWorktree } from '#runtime/agents/drivers'
// A bound, imported rather than duplicated: a test that hard-codes the budget
// passes against a driver that changed it.
import { MAX_FAST_ATTACH_ATTEMPTS } from '#runtime/agents/acp-driver'
import {
  _resetAcpRegistryForTests,
  acpConversation,
  acpConversationByHandle,
} from '#runtime/agents/acp-registry'
import { podExec } from '#runtime/k8s/substrate/stream-relay'
import type * as streamRelayModule from '#runtime/k8s/substrate/stream-relay'
import type { StreamChild } from '#runtime/k8s/substrate'
import type { AcpConversation } from '#runtime/agents/acp-client'
import type { AcpEventInit } from '@yaac/shared/acp'

/**
 * The driver seam, exercised the way the status watcher exercises it: connect,
 * feed the pod's side of the wire, and assert the observations that come back.
 *
 * Mocking is at the process boundary only — the relay dial and the one-shot
 * exec — so the real ControlModeClient, the real JSON-RPC peer, the real ACP
 * translation and the real conversation state machine all run. That is what
 * makes one test per mode enough to cover the protocol modules underneath
 * them; none of them is mocked out.
 */

vi.mock('#runtime/k8s/substrate/stream-relay', async (importOriginal) => ({
  ...await importOriginal<typeof streamRelayModule>(),
  podExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  dialCtrlStream: vi.fn(),
}))

/** A fake relay `ctrl` stream the test drives from the pod's side. */
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

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-drivers-'))
  setDataDir(dataDir)
  _resetAcpRegistryForTests()
  vi.mocked(podExec).mockReset()
  vi.mocked(podExec).mockResolvedValue({ stdout: '', stderr: '' } as never)
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
    }
    // TUI: the tool's own binary, pinned to the conversation id.
    expect(agentDriver('tui').launchCmd(spec)).toContain('claude --dangerously-skip-permissions')
    expect(agentDriver('tui').launchCmd(spec)).toContain('--session-id conv-1')

    // ACP: acpd supervising the adapter, with the socket named for the window
    // — that name is the conversation's handle everywhere else.
    const acp = agentDriver('acp').launchCmd(spec)
    expect(acp).toContain('node /opt/yaac/acpd/main.js')
    expect(acp).toContain('--sock /tmp/yaac-acp/claude-2.sock')
    expect(acp).toContain('-- claude-agent-acp')
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

  it('rejects a tool with no ACP adapter rather than launching a window that exits', () => {
    expect(() => agentDriver('acp').launchCmd({
      tool: 'opencode', agentSessionId: 'c', resume: false, windowName: 'opencode',
    })).toThrow(/no ACP adapter/)
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
    await vi.waitFor(() => expect(stream.writes.join('')).toContain('refresh-client -B'))
    stream.feed('%begin 1 102 1\n%end 1 102 1\n')

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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\ninit\n', stderr: '' } as never)
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
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'acp-1' } })}\n`)

    // The conversation id the agent minted is published — this is what the
    // registry records, replacing the TUI mode's hook and its log entirely.
    await vi.waitFor(() => expect(acpConversation('demo', 'wt-1', 'acp-1')).toBeDefined())
    await vi.waitFor(() => expect(seen).toContainEqual({
      kind: 'live-agents',
      agents: [{ handle: 'claude', tool: 'claude', agentSessionId: 'acp-1' }],
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

    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } })}\n`)
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'status', handle: 'claude', status: 'waiting' }))

    expect(events.map((e) => e.type)).toEqual(['turn-start', 'turn-end'])
    expect(events[1]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('resumes a recorded acp conversation with session/load instead of a new one', async () => {
    const stream = new FakeStream()
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
    connections.push(agentDriver('acp').connect(session, () => {}, {
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
    expect(stream.sent().find((m) => m.method === 'session/load')!.params)
      .toMatchObject({ sessionId: 'acp-old', cwd: '/workspace' })
    expect(stream.sent().some((m) => m.method === 'session/new')).toBe(false)
  })

  it('skips the handshake when reattaching to an agent that is already running', async () => {
    const stream = new FakeStream()
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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

  it('grants tool permission rather than prompting, matching the sandbox posture', async () => {
    const stream = new FakeStream()
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
    connections.push(agentDriver('acp').connect(session, () => {}, {
      dial: () => stream,
      // A reattach needs the recorded id: without one the conversation cannot
      // be addressed at all and the driver tears it down (covered below).
      recordedSessions: () => Promise.resolve([{ handle: 'claude', agentSessionId: 'acp-1' }]),
      log: () => {},
    }))
    await vi.waitFor(() => expect(acpConversationByHandle('demo', 'wt-1', 'claude')).toBeDefined())
    stream.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)

    stream.feed(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-1',
        options: [
          { optionId: 'no', kind: 'reject_once' },
          { optionId: 'yes-always', kind: 'allow_always' },
        ],
      },
    })}\n`)

    await vi.waitFor(() => expect(stream.sent().some((m) => m.id === 99)).toBe(true))
    // allow_always over allow_once: a session behind gVisor and an egress
    // allowlist is constrained by the sandbox, not by a prompt nobody sees.
    expect(stream.sent().find((m) => m.id === 99)!.result)
      .toEqual({ outcome: { outcome: 'selected', optionId: 'yes-always' } })
  })

  it('gives up on a reattach it cannot address rather than talking to the wrong session', async () => {
    const stream = new FakeStream()
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    // The relay delivers raw Buffers on TCP read boundaries, which land
    // wherever the network puts them. Decoded per chunk, a character split
    // across two reads becomes replacement characters in both halves — and
    // because the split can only fall inside a JSON string, the line still
    // parses and the corruption is silent.
    const stream = new FakeStream()
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
    const stream = new FakeStream()
    vi.mocked(podExec).mockResolvedValue({ stdout: 'claude\n', stderr: '' } as never)
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
