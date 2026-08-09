import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readAcpFirstPrompt, readAcpLog, replayAcpLog, tailAcpLog } from '#features/agents/acp-log'

/**
 * The record acpd writes is now a conversation's history, so this projection
 * is what a pane actually renders. It runs against raw text rather than a
 * conversation object because the point of the design is that the file stands
 * alone: no server, no agent, no pod required to read it.
 */

const line = (msg: unknown): string => JSON.stringify(msg)

/** acpd stamps one of these as byte 0 of every life; the tail tells lives
 *  apart by its id. */
const life = (id: string): string =>
  line({ jsonrpc: '2.0', method: '_acpd/life', params: { id } })

const update = (u: unknown): string => line({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { worktreeId: 'acp-1', update: u },
})

const prompt = (text: string): string => line({
  jsonrpc: '2.0',
  id: 'abc-1',
  method: 'session/prompt',
  params: { worktreeId: 'acp-1', prompt: [{ type: 'text', text }] },
})

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

describe('readAcpLog', () => {
  it('answers empty for a conversation that has not been recorded yet', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-log-'))
    dirs.push(dir)
    // Not an error: a conversation whose agent has not spoken has no history.
    expect(await readAcpLog(path.join(dir, 'missing.jsonl'))).toEqual([])
  })

  it('reads a record off disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'acp-1.jsonl')
    await fs.writeFile(file, [
      line({ jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } }),
      prompt('do it'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }),
    ].join('\n') + '\n')

    const events = await readAcpLog(file)
    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })
})

describe('tailAcpLog', () => {
  const tails: Array<{ close(): void }> = []
  afterEach(() => { for (const t of tails.splice(0)) t.close() })

  async function scratch(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-tail-'))
    dirs.push(dir)
    return path.join(dir, 'acp-1.jsonl')
  }

  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('reports an empty history for a record that does not exist yet', async () => {
    const batches: Array<{ events: unknown[]; reset: boolean }> = []
    tails.push(tailAcpLog(await scratch(), (events, reset) => batches.push({ events, reset }), { intervalMs: 20 }))

    // A conversation whose agent has not spoken has an empty history, not a
    // missing one — a pane must still learn that it is attached.
    await until(() => batches.length > 0)
    expect(batches[0]).toEqual({ events: [], reset: true })
  })

  it('delivers appended lines as they arrive, without re-sending what it had', async () => {
    const file = await scratch()
    await fs.writeFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } }) + '\n')
    const batches: Array<{ events: Array<{ type: string }>; reset: boolean }> = []
    tails.push(tailAcpLog(file, (events, reset) => batches.push({ events: events as Array<{ type: string }>, reset }), { intervalMs: 20 }))
    await until(() => batches.length > 0)
    expect(batches[0].reset).toBe(true)
    expect(batches[0].events).toHaveLength(1)

    await fs.appendFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } }) + '\n')
    await until(() => batches.length > 1)
    // Only the new line — a tail that re-sent its history would double every
    // message on every pass.
    expect(batches[1]).toMatchObject({ reset: false })
    expect(batches[1].events).toHaveLength(1)
  })

  it('holds a partial trailing line until the rest arrives', async () => {
    const file = await scratch()
    const full = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'split' } })
    await fs.writeFile(file, full.slice(0, 20))
    const batches: Array<{ events: unknown[] }> = []
    tails.push(tailAcpLog(file, (events) => batches.push({ events }), { intervalMs: 20 }))
    await until(() => batches.length > 0)
    // acpd appends as the agent streams, so a pass always lands mid-line.
    expect(batches[0].events).toEqual([])

    await fs.appendFile(file, full.slice(20) + '\n')
    await until(() => batches.some((b) => b.events.length > 0))
  })

  it('starts over when the record is truncated for a new agent life', async () => {
    const file = await scratch()
    await fs.writeFile(file, [
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old life' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } }),
    ].join('\n') + '\n')
    // What a pane holds, built the way the pane builds it: replace on reset,
    // append otherwise. Asserting on this rather than on one batch is the
    // point — `writeFile` truncates before it writes, so a pass can legally
    // land on an empty record and report the reset with no events in it.
    let view: Array<{ content?: Array<{ text?: string }> }> = []
    tails.push(tailAcpLog(file, (events, reset) => {
      const batch = events as typeof view
      view = reset ? batch : [...view, ...batch]
    }, { intervalMs: 20 }))
    await until(() => view.length === 2)

    // acpd opens the record with 'w', so a restart shortens it. Appending from
    // the old position would splice two conversations together.
    await fs.writeFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new life' } }) + '\n')
    await until(() => view.length === 1)
    expect(view[0]).toMatchObject({ content: [{ text: 'new life' }] })

    // And it stays that way: the old life must not come back on a later pass.
    await new Promise((r) => setTimeout(r, 100))
    expect(view).toHaveLength(1)
  })

  it('still reports the restart when it catches the record empty', async () => {
    // The race the previous test can only hit by luck. acpd's open(…, 'w')
    // empties the file before writing a byte, so a pass can see size 0: there
    // is nothing to project yet, but forgetting the reset would append the new
    // life's first events to the old life's transcript.
    const file = await scratch()
    await fs.writeFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old life' } }) + '\n')
    const batches: Array<{ events: unknown[]; reset: boolean }> = []
    tails.push(tailAcpLog(file, (events, reset) => batches.push({ events, reset }), { intervalMs: 20 }))
    await until(() => batches.length > 0)

    await fs.truncate(file, 0)
    await until(() => batches.length > 1)
    expect(batches[1]).toEqual({ events: [], reset: true })

    await fs.appendFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new life' } }) + '\n')
    await until(() => batches.length > 2)
    // Already reset above, so this is an ordinary append — not a second reset.
    expect(batches[2]).toMatchObject({ reset: false })
    expect(batches[2].events).toHaveLength(1)
  })

  it('holds a character split across a pass boundary', async () => {
    // acpd appends one writeSync per agent stdout chunk and those chunks split
    // characters, so a pass can see the file ending mid-sequence. Decoding
    // each pass's bytes on their own would put a U+FFFD on each side of the
    // split, inside JSON that still parses — silent corruption.
    const file = await scratch()
    const full = Buffer.from(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'héllo 😀 世界' } }) + '\n',
      'utf8',
    )
    // Split inside the emoji's 4-byte sequence.
    const at = full.indexOf(Buffer.from('😀', 'utf8')) + 2
    await fs.writeFile(file, full.subarray(0, at))

    const events: Array<{ content?: Array<{ text?: string }> }> = []
    tails.push(tailAcpLog(file, (batch) => events.push(...batch as typeof events), { intervalMs: 20 }))
    await until(() => events.length === 0)
    await new Promise((r) => setTimeout(r, 60))

    await fs.appendFile(file, full.subarray(at))
    await until(() => events.length > 0)
    expect(events[0].content?.[0].text).toBe('héllo 😀 世界')
  })

  it('starts over when a new life reuses the byte count of the one before', async () => {
    // Truncation is not always visible as a shrink: a restart whose
    // session/load replay regrows the file past where we were reading, inside
    // one tick, looks like an ordinary append. The life id is what makes the
    // distinction exact.
    const file = await scratch()
    const a = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } })
    await fs.writeFile(file, [life('life-1'), a].join('\n') + '\n')

    let view: Array<{ content?: Array<{ text?: string }> }> = []
    tails.push(tailAcpLog(file, (batch, reset) => {
      view = reset ? batch as typeof view : [...view, ...batch as typeof view]
    }, { intervalMs: 20 }))
    await until(() => view.length === 1)

    // Same length, different life: byte-identical size, wholly different
    // conversation.
    const b = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new' } })
    await fs.writeFile(file, [life('life-2'), b].join('\n') + '\n')
    await until(() => view.length === 1 && view[0].content?.[0].text === 'new')
  })

  it('flushes what has been appended even while a pass is already running', async () => {
    // `flush()` exists so the bridge can order a turn-end after the record's
    // contents. A flush that returned early because the interval had just
    // fired would resolve without reading the answer's last bytes, and the
    // turn would render above them.
    const file = await scratch()
    await fs.writeFile(file, '')
    const events: unknown[] = []
    const tail = tailAcpLog(file, (batch) => events.push(...batch), { intervalMs: 20 })
    tails.push(tail)
    await until(() => events.length === 0)

    await fs.appendFile(file, update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the last words' },
    }) + '\n')
    await tail.flush()
    // Not "eventually" — by the time flush resolves.
    expect(events).toHaveLength(1)
  })

  it('stops reading once closed', async () => {
    const file = await scratch()
    await fs.writeFile(file, '')
    const batches: unknown[] = []
    const tail = tailAcpLog(file, (events) => batches.push(events), { intervalMs: 20 })
    await until(() => batches.length > 0)
    tail.close()
    const after = batches.length

    await fs.appendFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignored' } }) + '\n')
    await new Promise((r) => setTimeout(r, 100))
    expect(batches.length).toBe(after)
  })
})

describe('readAcpFirstPrompt', () => {
  it('finds the opening message without a live conversation', async () => {
    // The registry labels a worktree from this, on a reconciler tick — so it
    // must come off disk rather than from something attached.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'acp-1.jsonl')
    await fs.writeFile(file, [
      line({ jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } }),
      line({ jsonrpc: '2.0', id: 'x-1', method: 'initialize', params: {} }),
      prompt('the founding ask'),
      prompt('a later one'),
    ].join('\n') + '\n')

    expect(await readAcpFirstPrompt(file)).toBe('the founding ask')
  })

  it('answers undefined for a record with no prompt, or none at all', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-log-'))
    dirs.push(dir)
    const file = path.join(dir, 'quiet.jsonl')
    await fs.writeFile(file, update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'unprompted' },
    }) + '\n')

    expect(await readAcpFirstPrompt(file)).toBeUndefined()
    expect(await readAcpFirstPrompt(path.join(dir, 'missing.jsonl'))).toBeUndefined()
  })
})

describe('replayAcpLog', () => {
  it('reconstructs user turns from the client\'s own prompts', () => {
    // The agent echoes a user message only when replaying under `session/load`,
    // so for anything said live these request lines are the only record that a
    // user spoke at all — which is why acpd tees both directions.
    const events = replayAcpLog([
      prompt('first ask'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } }),
      prompt('second ask'),
    ].join('\n'))

    expect(events.map((e) => e.type)).toEqual(['user', 'agent', 'user'])
    expect(events[0]).toMatchObject({ content: [{ type: 'text', text: 'first ask' }] })
    expect(events[2]).toMatchObject({ content: [{ type: 'text', text: 'second ask' }] })
  })

  it('numbers events from zero so an attach can continue past them', () => {
    const events = replayAcpLog([
      prompt('a'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'c' } }),
    ].join('\n'))
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('merges a tool call across its updates, as the live path does', () => {
    // Same `mergeToolCall` the live translation uses — one projection, so a
    // replayed conversation cannot disagree with the one that was watched.
    const events = replayAcpLog([
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Edit a.ts',
        kind: 'edit',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'writing' } }],
      }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
    ].join('\n'))

    expect(events).toHaveLength(2)
    // The patch carried only a status, so title, kind and content are inherited.
    expect(events[1]).toMatchObject({
      call: { toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'completed' },
    })
  })

  it('ignores the lines that carry no conversation content', () => {
    const events = replayAcpLog([
      line({ jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } }),
      line({ jsonrpc: '2.0', id: 'x-1', method: 'initialize', params: {} }),
      line({ jsonrpc: '2.0', id: 'x-1', result: { protocolVersion: 1 } }),
      line({ jsonrpc: '2.0', id: 'x-2', method: 'session/new', params: { cwd: '/workspace' } }),
      line({ jsonrpc: '2.0', id: 'x-2', result: { worktreeId: 'acp-1' } }),
      line({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'only this' } }),
    ].join('\n'))

    expect(events.map((e) => e.type)).toEqual(['agent'])
  })

  it('survives a partial trailing line, which a live record always has', () => {
    // acpd appends as the agent streams, so a read can land mid-write.
    const raw = [
      prompt('go'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
    ].join('\n') + '\n' + '{"jsonrpc":"2.0","method":"session/upda'

    const events = replayAcpLog(raw)
    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('skips adapter noise rather than losing the conversation around it', () => {
    const events = replayAcpLog([
      'warning: some adapter banner',
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } }),
    ].join('\n'))
    expect(events.map((e) => e.type)).toEqual(['agent'])
  })

})
