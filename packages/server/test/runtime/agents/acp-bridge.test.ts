import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { setDataDir } from '@yaac/shared/paths'
import { acpLogDir } from '@yaac/shared/project-paths'
import { attachAcp } from '#runtime/agents/acp-bridge'
import { AcpConversation } from '#runtime/agents/acp-client'
import { acpAdapterFor, type AcpAdapterProfile } from '#runtime/agents/acp-adapters'
import { readAcpInFlight, readAcpPendingPermissions } from '#runtime/agents/acp-log'
import {
  _resetAcpRegistryForTests,
  registerAcpConversation,
} from '#runtime/agents/acp-registry'
import type { JsonRpcTransport } from '#runtime/agents/acp-jsonrpc'
import type { AcpServerMessage } from '@yaac/shared/acp'

/**
 * These drive a real conversation over a fake transport, checking that a
 * pane attaching mid-conversation sees everything and that detaching leaves
 * the agent running.
 */

/** A transport where the test plays the pod's side. */
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
 * Whether a pane applying these frames in order (as `useAcpStream` does)
 * would think a turn is running: `hello` sets it, turn boundaries change it.
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

/** Write the log acpd would have written; history comes only from it. */
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

/**
 * A conversation past its handshake, wired to the log as the driver does,
 * so it recovers a running turn and pending asks. It reads the log when
 * constructed, so write the log first.
 */
function liveConversation(profile?: AcpAdapterProfile): AcpConversation {
  transport = new FakeTransport()
  const record = { slug: 'demo', workspaceId: 'wt-1', agentSessionId: 'acp-1' }
  const c = new AcpConversation({
    transport,
    cwd: '/workspace',
    resumeSessionId: 'acp-1',
    ...(profile !== undefined ? { profile } : {}),
    recoverInFlight: () => readAcpInFlight(record),
    recoverPendingPermissions: () => readAcpPendingPermissions(record),
    onSessionId: () => {},
    onBusy: () => {},
    onDown: () => {},
    log: () => {},
  })
  transport.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: false } })}\n`)
  return c
}

/** Recreate the conversation after the test has written its log. */
function reattach(profile?: AcpAdapterProfile): void {
  conversation.close()
  conversation = liveConversation(profile)
  registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, conversation)
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

/** Wait for `hello`, which follows reading the log. */
async function waitForHello(sock: FakeSocket): Promise<void> {
  await waitFor(() => sock.sent.some((m) => m.type === 'hello'))
}

/** The requests the conversation wrote to the agent with this method. */
function requests(method: string): Array<{ id: string | number; params: Record<string, unknown> }> {
  return transport.written
    .map((l) => JSON.parse(l.trim()) as { id: string | number; method?: string; params: Record<string, unknown> })
    .filter((m) => m.method === method)
}

/** Answer one of the conversation's requests as the agent. */
function reply(id: string | number, result: unknown): void {
  transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
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
    // Includes turns from before this server process started.
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
    // The user turn comes from the client's `session/prompt` line.
    expect(hello.events.map((e) => e.type)).toEqual(['user', 'agent'])
    expect(hello.events.map((e) => e.seq)).toEqual([0, 1])
  })

  it('greets with an empty history when nothing has been recorded yet', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    // An empty conversation is not an error.
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

    // Content reaches panes only through the log, so several tabs just work.
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
    await waitFor(() => requests('session/prompt').length === 1)
    const prompt = transport.written
      .map((l) => JSON.parse(l.trim()) as Record<string, unknown>)
      .find((m) => m.method === 'session/prompt')
    expect(prompt?.params).toEqual({
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'do the thing' }],
    })

    // The pane that started the turn also gets `turn-start`, which drives
    // its working indicator.
    await waitFor(() => sock.sent.some((m) => m.type === 'event' && m.event.type === 'turn-start'))
    expect(paneBusy(sock.sent)).toBe(true)

    // Detaching leaves the conversation and agent running.
    sock.clientClose()
    const before = sock.sent.length
    // Later output goes to the log, which the detached pane no longer reads.
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

  it('sends a message\'s images after its words, typed by their bytes, and refuses a non-image', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64')
    const prompts = (): Array<{ id: string; params: unknown }> => transport.written
      .map((l) => JSON.parse(l.trim()) as { id: string; method?: string; params: unknown })
      .filter((m) => m.method === 'session/prompt')
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    // Declared JPEG but actually PNG: the agent gets the sniffed type and the
    // re-encoded bytes, not the original junk.
    sock.clientSend({ type: 'prompt', text: 'what is this?', images: [{ type: 'image', mimeType: 'image/jpeg', data: `!${png}` }] })
    await waitFor(() => prompts().length === 1)
    expect(prompts()[0].params).toEqual({
      sessionId: 'acp-1',
      prompt: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    })

    // Not an image: rejected, and the pane is told.
    sock.clientSend({ type: 'prompt', text: 'and this?', images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] })
    await waitFor(() => sock.sent.some((m) => m.type === 'event' && m.event.type === 'error'))
    expect(prompts()).toHaveLength(1)

    // All of a message's images together must fit the cap.
    const big = Buffer.alloc(3 * 1024 * 1024)
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(big)
    const errors = (): number => sock.sent.filter((m) => m.type === 'event' && m.event.type === 'error').length
    sock.clientSend({
      type: 'prompt',
      text: 'two screenshots',
      images: [1, 2].map(() => ({ type: 'image', mimeType: 'image/png', data: big.toString('base64') })),
    })
    await waitFor(() => errors() === 2)
    expect(prompts()).toHaveLength(1)

    // A message may be an image alone.
    transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id: prompts()[0].id, result: { stopReason: 'end_turn' } })}\n`)
    sock.clientSend({ type: 'prompt', text: ' ', images: [{ type: 'image', mimeType: 'image/png', data: png }] })
    await waitFor(() => prompts().length === 2)
    expect(prompts()[1].params).toEqual({
      sessionId: 'acp-1',
      prompt: [{ type: 'image', mimeType: 'image/png', data: png }],
    })
  })

  it('steers a mid-turn message into the running turn for an adapter that can, as its TUI does', async () => {
    reattach(acpAdapterFor('claude'))
    await waitFor(() => conversation.status !== undefined)
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    sock.clientSend({ type: 'prompt', text: 'fix the build' })
    await waitFor(() => requests('session/prompt').length === 1)

    // Mid-turn: sent at once as a steer, not held for the turn to end.
    sock.clientSend({ type: 'prompt', text: 'and the lint' })
    await waitFor(() => requests('_session/steering').length === 1)
    const [steer] = requests('_session/steering')
    expect(steer.params).toEqual({
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'and the lint' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    })
    reply(steer.id, { outcome: 'injected' })

    // The turn ended just as the next one arrived: the agent hands it back,
    // and it runs as the next turn.
    sock.clientSend({ type: 'prompt', text: 'then commit' })
    await waitFor(() => requests('_session/steering').length === 2)
    const late = requests('_session/steering')[1]
    reply(requests('session/prompt')[0].id, { stopReason: 'end_turn' })
    await waitFor(() => !conversation.isBusy)
    await new Promise((r) => setTimeout(r, 10))
    reply(late.id, { outcome: 'promptRequired' })
    await waitFor(() => requests('session/prompt').length === 2)
    expect(requests('session/prompt')[1].params.prompt).toEqual([{ type: 'text', text: 'then commit' }])
    // Never shown as queued: it went straight to the agent.
    expect(sock.sent.some((m) => m.type === 'queue')).toBe(false)

    // In the record, a steer the agent took is a user message inside the
    // turn; one it handed back shows once, as the prompt that followed.
    await record([
      { jsonrpc: '2.0', id: 'a', method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'fix the build' }] } },
      { jsonrpc: '2.0', id: 'b', method: '_session/steering', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'and the lint' }] } },
      { jsonrpc: '2.0', id: 'b', result: { outcome: 'injected' } },
      { jsonrpc: '2.0', id: 'c', method: '_session/steering', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'then commit' }] } },
      { jsonrpc: '2.0', id: 'a', result: { stopReason: 'end_turn' } },
      { jsonrpc: '2.0', id: 'c', result: { outcome: 'promptRequired' } },
      { jsonrpc: '2.0', id: 'd', method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'then commit' }] } },
    ])
    const users = (): unknown[] => sock.sent
      .flatMap((m) => m.type === 'event' ? [m.event] : m.type === 'hello' ? m.events : [])
      .filter((e) => e.type === 'user')
    await waitFor(() => users().length === 3)
    expect(users()).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: 'fix the build' }] }),
      expect.objectContaining({ content: [{ type: 'text', text: 'and the lint' }], steered: true }),
      expect.objectContaining({ content: [{ type: 'text', text: 'then commit' }] }),
    ])
  })

  it('queues a steer the agent does not take, in the order messages were sent', async () => {
    reattach(acpAdapterFor('claude'))
    await waitFor(() => conversation.status !== undefined)
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    const texts = (method: string): unknown[] => requests(method).map((r) => (r.params.prompt as Array<{ text: string }>)[0].text)
    sock.clientSend({ type: 'prompt', text: 'fix the build' })
    await waitFor(() => requests('session/prompt').length === 1)

    // codex-acp answers a steer it could not deliver with `failed`.
    sock.clientSend({ type: 'prompt', text: 'and the lint' })
    await waitFor(() => requests('_session/steering').length === 1)
    reply(requests('_session/steering')[0].id, { outcome: 'failed' })
    await waitFor(() => conversation.queuedPrompts.length === 1)

    // An adapter without the method (an unpatched pi-acp) is queued too.
    reattach(acpAdapterFor('pi'))
    await waitFor(() => conversation.status !== undefined)
    const late = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', late)
    await waitForHello(late)
    late.clientSend({ type: 'prompt', text: 'first' })
    await waitFor(() => requests('session/prompt').length === 1)
    late.clientSend({ type: 'prompt', text: 'A' })
    await waitFor(() => requests('_session/steering').length === 1)
    // B arrives while A's steer is unanswered and the turn has ended, and
    // still waits for A.
    reply(requests('session/prompt')[0].id, { stopReason: 'end_turn' })
    late.clientSend({ type: 'prompt', text: 'B' })
    await new Promise((r) => setTimeout(r, 50))
    expect(requests('session/prompt')).toHaveLength(1)
    transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id: requests('_session/steering')[0].id, error: { code: -32601, message: 'Method not found' } })}\n`)
    await waitFor(() => requests('session/prompt').length === 2)
    // A runs as its own turn, which B then joins.
    await waitFor(() => requests('_session/steering').length === 2)
    expect(texts('session/prompt')).toEqual(['first', 'A'])
    expect(texts('_session/steering')).toEqual(['A', 'B'])
    late.clientClose()
  })

  it('holds a turn codex starts itself from a late steer as running until codex reports idle', async () => {
    // codex-acp ignores `promptRequired`: a steer landing as its turn ends
    // starts a turn no `session/prompt` reply of ours will ever end.
    reattach(acpAdapterFor('codex'))
    await waitFor(() => conversation.status !== undefined)
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    sock.clientSend({ type: 'prompt', text: 'fix the build' })
    await waitFor(() => requests('session/prompt').length === 1)
    sock.clientSend({ type: 'prompt', text: 'and the lint' })
    await waitFor(() => requests('_session/steering').length === 1)

    reply(requests('session/prompt')[0].id, { stopReason: 'end_turn' })
    await waitFor(() => !conversation.isBusy)
    reply(requests('_session/steering')[0].id, { outcome: 'startedNewTurn' })
    await waitFor(() => conversation.isBusy)
    await waitFor(() => paneBusy(sock.sent))

    const threadStatus = (type: string): string => `${JSON.stringify(updateLine({
      sessionUpdate: 'session_info_update',
      _meta: { codex: { threadStatus: { type } } },
    }))}\n`
    transport.feed(threadStatus('active'))
    await new Promise((r) => setTimeout(r, 20))
    expect(conversation.isBusy).toBe(true)
    transport.feed(threadStatus('idle'))
    await waitFor(() => !conversation.isBusy)
    await waitFor(() => !paneBusy(sock.sent))

    // A reattach mid-way through such a turn finds it running in the record,
    // and one after codex went idle finds it over.
    const life = [
      { jsonrpc: '2.0', id: 's1', method: '_session/steering', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'x' }] } },
      { jsonrpc: '2.0', id: 's1', result: { outcome: 'startedNewTurn' } },
    ]
    const ref = { slug: 'demo', workspaceId: 'wt-1', agentSessionId: 'acp-1' }
    await record(life)
    expect(await readAcpInFlight(ref)).toBe(true)
    await record([...life, JSON.parse(threadStatus('idle')) as unknown])
    expect(await readAcpInFlight(ref)).toBe(false)
  })

  it('queues a mid-turn message for an adapter that cannot steer, shown to every pane until it runs', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    sock.clientSend({ type: 'prompt', text: 'fix the build' })
    await waitFor(() => requests('session/prompt').length === 1)

    sock.clientSend({ type: 'prompt', text: 'and the lint' })
    sock.clientSend({ type: 'prompt', text: 'then commit' })
    const lastQueue = (s: FakeSocket): unknown[] | undefined => s.sent.flatMap((m) => {
      if (m.type === 'queue') return [m.queued]
      return m.type === 'hello' ? [m.queued] : []
    }).at(-1)
    await waitFor(() => lastQueue(sock)?.length === 2)
    expect(requests('session/prompt')).toHaveLength(1)
    expect(lastQueue(sock)).toEqual(conversation.queuedPrompts)
    expect(conversation.queuedPrompts.map((q) => [q.text, q.images])).toEqual([['and the lint', 0], ['then commit', 0]])

    // A pane attaching now is greeted with the queue.
    const late = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', late)
    await waitForHello(late)
    expect(lastQueue(late)).toHaveLength(2)

    // Dropping one means the agent never sees it.
    const [dropped] = conversation.queuedPrompts
    sock.clientSend({ type: 'unqueue', id: dropped.id })
    await waitFor(() => lastQueue(late)?.length === 1)

    // The next queued message goes out only once panes have this turn's end,
    // so a pane never draws it inside the turn it followed.
    const write = transport.write.bind(transport)
    let endedFirst: boolean | undefined
    transport.write = (data: string): void => {
      if (data.includes('session/prompt')) endedFirst ??= sock.sent.some((m) => m.type === 'event' && m.event.type === 'turn-end')
      write(data)
    }
    reply(requests('session/prompt')[0].id, { stopReason: 'end_turn' })
    await waitFor(() => requests('session/prompt').length === 2)
    expect(endedFirst).toBe(true)
    expect(requests('session/prompt')[1].params.prompt).toEqual([{ type: 'text', text: 'then commit' }])
    await waitFor(() => lastQueue(sock)?.length === 0)
    expect(paneBusy(sock.sent)).toBe(true)
    late.clientClose()
  })

  it('cancels the running turn without tearing the pane down', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    sock.clientSend({ type: 'prompt', text: 'long job' })
    await waitFor(() => requests('session/prompt').length === 1)

    sock.clientSend({ type: 'cancel' })
    const cancel = transport.written
      .map((l) => JSON.parse(l.trim()) as Record<string, unknown>)
      .find((m) => m.method === 'session/cancel')
    expect(cancel?.params).toEqual({ sessionId: 'acp-1' })
    expect(sock.closedWith).toBeUndefined()
  })

  it('routes a permission answer to the agent, and replays a pending ask on attach', async () => {
    // The bridge sends the pane nothing for the answer: acpd records the
    // reply and the log tail reports it as `permission-resolved`.
    await record([
      { jsonrpc: '2.0', id: 'p-1', method: 'session/prompt', params: { sessionId: 'acp-1', prompt: [{ type: 'text', text: 'clean up' }] } },
      {
        jsonrpc: '2.0',
        id: 55,
        method: 'session/request_permission',
        params: {
          sessionId: 'acp-1',
          toolCall: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute' },
          options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
        },
      },
    ])
    reattach()
    await waitFor(() => conversation.isAwaitingPermission)
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    // A pane joining mid-ask is shown the question.
    const hello = sock.sent.find((m) => m.type === 'hello')!
    expect(hello.events.map((e) => e.type)).toEqual(['user', 'permission-request'])
    expect(hello.events[1]).toMatchObject({
      requestId: '55',
      options: [{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' }],
    })

    // The ask was recovered from the log; the answer uses the agent's own id.
    sock.clientSend({ type: 'permission', requestId: '55', optionId: 'allow' })
    await waitFor(() => transport.written.some((l) => l.includes('"outcome"')))
    const reply = transport.written
      .map((l) => JSON.parse(l.trim()) as Record<string, unknown>)
      .find((m) => m.result !== undefined)!
    expect(reply.id).toBe(55)
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  })

  it('lands a pane idle when the turn it is greeting ends underneath it', async () => {
    // `hello` reads `isBusy` when sent, and turn boundaries are sent after a
    // flush of the same log tail, so a stale `busy: true` never arrives after
    // the `turn-end` that ends it.
    void conversation.prompt('long job').catch(() => { /* ended below */ })
    await waitFor(() => transport.written.some((l) => l.includes('session/prompt')))
    expect(conversation.isBusy).toBe(true)

    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    // Answer while the first log pass (which sends hello) is still reading.
    const id = transport.written
      .map((l) => JSON.parse(l.trim()) as { id?: string | number; method?: string })
      .find((m) => m.method === 'session/prompt')?.id
    transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n`)

    await waitForHello(sock)
    await waitFor(() => !conversation.isBusy)
    // Give any late frame time to arrive.
    await new Promise((r) => setTimeout(r, 250))
    expect(paneBusy(sock.sent)).toBe(false)
    sock.clientClose()
  })

  it('greets a pane with a posture that never took, which the handshake had nobody to tell', async () => {
    // The refusal is reported during the handshake, before any pane can
    // attach, so it must be repeated on hello. It matters for codex, whose
    // default mode (`agent`) is looser than the `accept-edits` asked for.
    conversation.close()
    transport = new FakeTransport()
    conversation = new AcpConversation({
      transport,
      cwd: '/workspace',
      profile: acpAdapterFor('codex'),
      permissionMode: () => 'accept-edits',
      onSessionId: () => {},
      onBusy: () => {},
      onDown: () => {},
      log: () => {},
    })
    registerAcpConversation('demo', 'wt-1', { handle: 'codex', agentSessionId: 'acp-1' }, conversation)
    // Only used to know when the report has happened, so the attach below
    // cannot catch it through the live subscription.
    const reportedLive: string[] = []
    const stopProbe = conversation.subscribe((e) => {
      if (e.type === 'error') reportedLive.push(e.message)
    })
    transport.feed(`${JSON.stringify({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } })}\n`)

    const sent = (method: string): { id: number } | undefined =>
      transport.written.map((l) => JSON.parse(l) as { id: number; method?: string })
        .find((m) => m.method === method)
    const reply = (id: number, body: unknown): void => {
      transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id, ...body as object })}\n`)
    }

    await waitFor(() => sent('initialize') !== undefined)
    reply(sent('initialize')!.id, { result: { protocolVersion: 1, agentCapabilities: {} } })
    await waitFor(() => sent('session/new') !== undefined)
    reply(sent('session/new')!.id, {
      result: {
        sessionId: 'acp-1',
        modes: {
          currentModeId: 'agent',
          availableModes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'agent' }, { id: 'agent-full-access' }],
        },
      },
    })
    await waitFor(() => sent('session/set_mode') !== undefined)
    reply(sent('session/set_mode')!.id, { error: { code: -32603, message: 'mode unavailable' } })

    // Reported while no pane was attached.
    await waitFor(() => reportedLive.length > 0)
    stopProbe()

    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    await waitFor(() => sock.sent.some((m) => m.type === 'event' && m.event.type === 'error'))
    const reported = sock.sent
      .flatMap((m) => (m.type === 'event' && m.event.type === 'error' ? [m.event.message] : []))
    expect(reported.join(' ')).toContain('workspace-write')
    // Names the mode actually in effect.
    expect(reported.join(' ')).toContain('agent')
    // Sent after hello, so it is not mistaken for old history.
    const helloAt = sock.sent.findIndex((m) => m.type === 'hello')
    const errorAt = sock.sent.findIndex((m) => m.type === 'event' && m.event.type === 'error')
    expect(errorAt).toBeGreaterThan(helloAt)
  })

  it('switches to a model the session offered, refuses any other, and reports an agent refusal', async () => {
    await record([
      { jsonrpc: '2.0', id: 'x-1', result: { sessionId: 'acp-1', configOptions: [{
        id: 'model', currentValue: 'opus', options: [{ value: 'opus' }, { value: 'sonnet' }, { value: 'retired' }],
      }] } },
    ])
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)
    const requests = (): Array<{ id: number; method?: string; params?: unknown }> =>
      transport.written.map((l) => JSON.parse(l) as { id: number; method?: string; params?: unknown })
        .filter((m) => m.method === 'session/set_config_option')

    // Not on offer: the browser's string never reaches the agent or the row.
    sock.clientSend({ type: 'model', modelId: "x'; rm -rf /" })
    sock.clientSend({ type: 'model', modelId: 'sonnet' })
    await waitFor(() => requests().length === 1)
    expect(requests()).toHaveLength(1)
    expect(requests()[0].params).toEqual({ sessionId: 'acp-1', configId: 'model', value: 'sonnet' })
    transport.feed(`${JSON.stringify({ jsonrpc: '2.0', id: requests()[0].id, result: { configOptions: [] } })}\n`)

    sock.clientSend({ type: 'model', modelId: 'retired' })
    await waitFor(() => requests().length === 2)
    transport.feed(`${JSON.stringify({
      jsonrpc: '2.0', id: requests()[1].id, error: { code: -32602, message: 'Invalid value' },
    })}\n`)
    await waitFor(() => sock.sent.some((m) => m.type === 'event' && m.event.type === 'error'))
    const errors = sock.sent.flatMap((m) => (m.type === 'event' && m.event.type === 'error' ? [m.event.message] : []))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"retired"')
    expect(errors[0]).toContain('Invalid value')
  })

  it('tells a pane the conversation is not live rather than hanging it open', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'no-such-conversation', sock)
    await new Promise((r) => setTimeout(r, 20))

    // A booting workspace or reconnecting stream; the pane retries.
    expect(sock.sent).toEqual([{ type: 'health', connected: false }])
    expect(sock.closedWith).toBe('no live conversation')
  })

  it('closes a pane whose conversation is torn down, so its re-attach finds the replacement', async () => {
    const sock = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', sock)
    await waitForHello(sock)

    // A workspace restart: this conversation closes and a new one is later
    // registered under the same name.
    conversation.close()
    expect(sock.sent.some((m) => m.type === 'health' && !m.connected)).toBe(true)
    // The socket is bound to the old conversation object, so it must close
    // to make the pane reconnect to the new one.
    expect(sock.closedWith).toBe('conversation closed')
    sock.clientClose()

    const abandoned = transport
    conversation = liveConversation()
    registerAcpConversation('demo', 'wt-1', { handle: 'claude', agentSessionId: 'acp-1' }, conversation)

    const next = new FakeSocket()
    attachAcp('demo', 'wt-1', 'acp-1', next)
    await waitForHello(next)
    next.clientSend({ type: 'prompt', text: 'carry on' })

    // The reconnected pane drives the new conversation.
    await waitFor(() => transport.written.some((l) => l.includes('session/prompt')))
    expect(abandoned.written.some((l) => l.includes('session/prompt'))).toBe(false)
  })
})
