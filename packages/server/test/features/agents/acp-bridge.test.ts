import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir } from '@yaac/shared/project-paths'
import { attachAcp } from '#features/agents/acp-bridge'
import { AcpConversation } from '#features/agents/acp-client'
import {
  _resetAcpRegistryForTests,
  registerAcpConversation,
} from '#features/agents/acp-registry'
import type { JsonRpcTransport } from '#features/agents/acp-jsonrpc'
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

  it('tells a pane the conversation is not live rather than hanging it open', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'no-such-conversation', sock)
    await new Promise((r) => setTimeout(r, 20))

    // A booting worktree, or a connection mid-respawn — normal states the
    // pane retries out of, not faults.
    expect(sock.sent).toEqual([{ type: 'health', connected: false }])
    expect(sock.closedWith).toBe('no live conversation')
  })

  it('greys the pane out when the conversation is torn down under it', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    conversation.close()

    expect(sock.sent.some((m) => m.type === 'health' && !m.connected)).toBe(true)
  })
})
