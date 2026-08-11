import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir } from '@yaac/shared/project-paths'
import { attachAcp } from '#runtime/agents/acp-bridge'
import { AcpConversation } from '#runtime/agents/acp-client'
import {
  _resetAcpRegistryForTests,
  registerAcpConversation,
} from '#runtime/agents/acp-registry'
import type { JsonRpcTransport } from '#runtime/agents/acp-jsonrpc'
import type { AcpServerMessage } from '@yaac/shared/acp'

/**
 * The bridge is thin by design, so these drive a REAL conversation behind it
 * (over a fake transport) rather than a stub: what matters is the handoff —
 * that a pane attaching mid-conversation sees everything, and that detaching
 * leaves the agent alone.
 */

/** A transport the test plays the pod's side of. */
class FakeTransport implements JsonRpcTransport {
  written: string[] = []
  closed = false
  private dataCb: ((chunk: string) => void) | null = null
  private closeCb: ((reason: string) => void) | null = null
  write(data: string): void { this.written.push(data) }
  onData(cb: (chunk: string) => void): void { this.dataCb = cb }
  onClose(cb: (reason: string) => void): void { this.closeCb = cb }
  close(): void { this.closed = true; this.closeCb?.('closed') }
  feed(data: string): void { this.dataCb?.(data) }
}

/** A pane socket the test reads back. */
class FakeSocket {
  sent: AcpServerMessage[] = []
  closedWith: string | undefined
  private messageCb: ((data: Buffer, isBinary: boolean) => void) | null = null
  private closeCb: (() => void) | null = null
  send(data: string): void { this.sent.push(JSON.parse(data) as AcpServerMessage) }
  close(_code?: number, reason?: string): void { this.closedWith = reason }
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void { this.messageCb = cb }
  onClose(cb: () => void): void { this.closeCb = cb }
  clientSend(msg: unknown): void { this.messageCb?.(Buffer.from(JSON.stringify(msg)), false) }
  clientBinary(data: Buffer): void { this.messageCb?.(data, true) }
  clientClose(): void { this.closeCb?.() }
}

/**
 * What a pane folding these frames in order would conclude about the turn —
 * the client's own rule (`useAcpStream`), modelled here because the property
 * under test is the ORDER frames leave the bridge in, which only a consumer
 * that folds them can express. A greeting sets the state; boundaries move it.
 */
function paneBusy(sent: AcpServerMessage[]): boolean {
  let busy = false
  for (const msg of sent) {
    if (msg.type === 'hello') busy = msg.busy
    if (msg.type !== 'event') continue
    if (msg.event.type === 'turn-start') busy = true
    if (msg.event.type === 'turn-end' || msg.event.type === 'error') busy = false
  }
  return busy
}

let transport: FakeTransport
let conversation: AcpConversation
let dataDir: string

/**
 * Write the record acpd would have written. History comes from this file now,
 * not from the server, so a bridge test that wants history has to put it on
 * disk — which is the point of the change.
 */
async function record(lines: unknown[]): Promise<void> {
  const dir = acpLogDir('demo', 'wt-1')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'acp-1.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

const updateLine = (u: unknown): unknown => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 'acp-1', update: u },
})

/** A conversation already past its handshake, holding a short history. */
function liveConversation(): AcpConversation {
  transport = new FakeTransport()
  const c = new AcpConversation({
    transport,
    cwd: '/workspace',
    resumeSessionId: 'acp-1',
    onSessionId: () => {},
    onBusy: () => {},
    onDown: () => {},
    log: () => {},
  })
  transport.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
  return c
}


beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-bridge-'))
  setDataDir(dataDir)
  _resetAcpRegistryForTests()
  conversation = liveConversation()
  registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, conversation)
})

afterEach(async () => {
  conversation.close()
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** The bridge reads the record before it can greet, so tests wait for hello. */
async function waitForHello(sock: FakeSocket): Promise<void> {
  await waitFor(() => sock.sent.some((m) => m.type === 'hello'))
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('attachAcp', () => {
  it('replays the recorded conversation so a pane attaching late sees all of it', async () => {
    // The record is what acpd wrote while relaying — including turns this
    // server process never witnessed, which is the property the in-memory log
    // could not offer.
    await record([
      { jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } },
      { jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'do it' }] } },
      updateLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier' } }),
    ])

    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    const hello = sock.sent.find((m) => m.type === 'hello')
    expect(hello?.type).toBe('hello')
    if (hello?.type !== 'hello') throw new Error('unreachable')
    expect(hello.agentSessionId).toBe('acp-1')
    // The user's own turn comes from the client's `session/prompt` line: the
    // agent echoes a user message only when replaying under `session/load`.
    expect(hello.events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(hello.events.map((e) => e.seq)).toEqual([0, 1])
  })

  it('greets with an empty history when nothing has been recorded yet', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    // A conversation whose agent has not spoken is not an error.
    const hello = sock.sent.find((m) => m.type === 'hello')
    if (hello?.type !== 'hello') throw new Error('unreachable')
    expect(hello.events).toEqual([])
  })

  it('streams appended content to every attached pane', async () => {
    const a = new FakeSocket()
    const b = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', a)
    attachAcp('demo', 'wt-1', 'acp-1', b)
    await waitForHello(a)
    await waitForHello(b)

    // Content reaches a pane by ONE path — the record — so a message appears
    // by being appended to it, not by crossing the socket. Two browser tabs on
    // one conversation is ordinary, not a special case.
    await record([updateLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })])

    for (const sock of [a, b]) {
      await waitFor(() => sock.sent.some((m) => m.type === 'event' || (m.type === 'hello' && m.events.length > 0)))
      const seen = sock.sent.flatMap((m) => m.type === 'event' ? [m.event] : m.type === 'hello' ? m.events : [])
      expect(seen).toContainEqual(expect.objectContaining({
        type: 'agent',
        content: [{ type: 'text', text: 'hi' }],
      }))
    }
  })

  it('forwards a prompt to the agent and stops forwarding once the pane detaches', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    sock.clientSend({ type: 'prompt', text: 'do the thing' })
    await Promise.resolve()
    await Promise.resolve()
    const prompt = transport.written
      .map((l) => JSON.parse(l.trim()) as Record<string, unknown>)
      .find((m) => m.method === 'session/prompt')
    expect(prompt?.params).toEqual({
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    })

    // And the turn comes back to the pane that started it. This is the
    // ordinary case the working indicator runs on: content is not read as a
    // boundary, so a `turn-start` that never arrived would leave a live turn
    // invisible on the very pane that asked for it.
    await waitFor(() => sock.sent.some((m) => m.type === 'event' && m.event.type === 'turn-start'))
    expect(paneBusy(sock.sent)).toBe(true)

    // Detaching is free: the conversation (and the agent behind it) is
    // untouched — that is the whole reason acpd exists.
    sock.clientClose()
    const before = sock.sent.length
    // The conversation carries on without the pane — that is the whole point —
    // and its output lands in the record, which the detached pane no longer
    // tails.
    await record([updateLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still working' } })])
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.sent.length).toBe(before)
  })

  it('ignores an empty prompt and a binary frame instead of forwarding garbage', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    sock.clientSend({ type: 'prompt', text: '   ' })
    sock.clientBinary(Buffer.from('not json'))
    sock.clientSend({ nonsense: true })
    await Promise.resolve()

    expect(transport.written.some((l) => l.includes('session/prompt'))).toBe(false)
  })

  it('cancels the running turn without tearing the pane down', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    sock.clientSend({ type: 'prompt', text: 'long job' })
    await Promise.resolve()
    await Promise.resolve()

    sock.clientSend({ type: 'cancel' })
    const cancel = transport.written
      .map((l) => JSON.parse(l.trim()) as Record<string, unknown>)
      .find((m) => m.method === 'session/cancel')
    expect(cancel?.params).toEqual({ sessionId: 'acp-1' })
    expect(sock.closedWith).toBeUndefined()
  })

  it('lands a pane idle when the turn it is greeting ends underneath it', async () => {
    // The no-latch guarantee is an ordering invariant rather than a counter,
    // and it carries the whole fix: `hello` reads `isBusy` in the tick it is
    // sent, and every boundary is delivered behind a flush of the same tail
    // chain. So a turn ending around the greeting either shows up *in* it or
    // arrives *after* it — a stale `busy: true` can never land on top of the
    // `turn-end` that contradicts it, whichever side the boundary falls.
    void conversation.prompt('long job').catch(() => { /* ended below */ })
    await waitFor(() => transport.written.some((l) => l.includes('session/prompt')))
    expect(conversation.isBusy).toBe(true)

    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    // Answered inside the attach's own tick, so the reply is in flight while
    // the first tail pass — the one that greets — is still reading the record.
    const id = transport.written
      .map((l) => JSON.parse(l.trim()) as { id?: string | number; method?: string })
      .find((m) => m.method === 'session/prompt')?.id
    transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`)

    await waitForHello(sock)
    await waitFor(() => !conversation.isBusy)
    // Long enough for a late frame to arrive and spoil it, if ordering let one.
    await new Promise((r) => setTimeout(r, 250))
    expect(paneBusy(sock.sent)).toBe(false)
    sock.clientClose()
  })

  it('tells a pane the conversation is not live rather than hanging it open', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'no-such-conversation', sock)
    await new Promise((r) => setTimeout(r, 20))

    // A booting worktree, or a connection mid-respawn — normal states the
    // pane retries out of, not faults.
    expect(sock.sent).toEqual([{ type: 'health', connected: false }])
    expect(sock.closedWith).toBe('no live conversation')
  })

  it('closes a pane whose conversation is torn down, so its re-attach finds the replacement', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    // What a worktree restart looks like from here: this conversation is
    // dropped, and a fresh one is registered under the same name once the new
    // pod's agent is up.
    conversation.close()
    expect(sock.sent.some((m) => m.type === 'health' && !m.connected)).toBe(true)
    // Greying out alone would stall the pane for good. It is bound to the
    // conversation OBJECT, not to the name, and only a closed socket makes it
    // come back — left open it holds a dead peer, so its Stop reaches nothing
    // and the replacement's turn boundaries go to subscribers it is not among.
    expect(sock.closedWith).toBe('conversation closed')
    sock.clientClose()

    const abandoned = transport
    conversation = liveConversation()
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, conversation)

    const next = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', next)
    await waitForHello(next)
    next.clientSend({ type: 'prompt', text: 'carry on' })

    // The re-attached pane drives the live conversation, which is the whole
    // point of making it reconnect.
    await waitFor(() => transport.written.some((l) => l.includes('session/prompt')))
    expect(abandoned.written.some((l) => l.includes('session/prompt'))).toBe(false)
  })
})
