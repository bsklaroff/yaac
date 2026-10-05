import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  readAcpFirstPrompt,
  readAcpPendingPermissions,
  replayAcpLog,
  tailAcpLog,
  MAX_ACP_RECORD_BYTES,
  type AcpRecordRef,
} from '#runtime/agents/acp-log'
import { acpLogDir, setDataDir } from '@yaac/shared/project-paths'

/**
 * The log acpd writes is a conversation's history and what a pane renders.
 * These tests use raw file text, since reading it needs no server, agent or
 * pod.
 */

const line = (msg: unknown): string => JSON.stringify(msg)

/** The first line acpd writes for each agent run; its id tells runs apart. */
const life = (id: string): string =>
  line({ jsonrpc: '2.0', method: '_acpd/life', params: { id } })

const update = (u: unknown): string => line({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { workspaceId: 'acp-1', update: u },
})

const prompt = (text: string): string => line({
  jsonrpc: '2.0',
  id: 'abc-1',
  method: 'session/prompt',
  params: { workspaceId: 'acp-1', prompt: [{ type: 'text', text }] },
})

/** A permission request from the agent, as acpd records it. */
const ask = (id: string | number, title = 'rm -rf build'): string => line({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 'call-1', title, kind: 'execute' },
    options: [
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
    ],
  },
})

/** yaac's answer to one, also recorded by acpd. */
const answer = (id: string | number, optionId?: string): string => line({
  jsonrpc: '2.0',
  id,
  result: optionId === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId } },
})

let dataDir: string
beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-acp-log-'))
  setDataDir(dataDir)
})
afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

let seq = 0
/** A fresh conversation log and the ref a reader uses for it. */
async function record(): Promise<{ file: string; ref: AcpRecordRef }> {
  const ref = { slug: 'demo', workspaceId: `wt-${String(++seq)}`, agentSessionId: 'acp-1' }
  const dir = acpLogDir(ref.slug, ref.workspaceId)
  await fs.mkdir(dir, { recursive: true })
  return { ref, file: path.join(dir, 'acp-1.jsonl') }
}

describe('tailAcpLog', () => {
  const tails: Array<{ close(): void }> = []
  afterEach(() => { for (const t of tails.splice(0)) t.close() })

  async function scratch(): Promise<{ file: string; ref: AcpRecordRef }> {
    return record()
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
    tails.push(tailAcpLog((await scratch()).ref, (events, reset) => batches.push({ events, reset }), { intervalMs: 20 }))

    // An empty history is still reported, so the pane knows it is attached.
    await until(() => batches.length > 0)
    expect(batches[0]).toEqual({ events: [], reset: true })
  })

  it('delivers appended lines as they arrive, without re-sending what it had', async () => {
    const { file, ref } = await scratch()
    await fs.writeFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } }) + '\n')
    const batches: Array<{ events: Array<{ type: string }>; reset: boolean }> = []
    tails.push(tailAcpLog(ref, (events, reset) => batches.push({ events: events, reset }), { intervalMs: 20 }))
    await until(() => batches.length > 0)
    expect(batches[0].reset).toBe(true)
    expect(batches[0].events).toHaveLength(1)

    await fs.appendFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } }) + '\n')
    await until(() => batches.length > 1)
    // Only the new line, not the whole history again.
    expect(batches[1]).toMatchObject({ reset: false })
    expect(batches[1].events).toHaveLength(1)
  })

  it('holds a partial trailing line until the rest arrives', async () => {
    const { file, ref } = await scratch()
    const full = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'split' } })
    await fs.writeFile(file, full.slice(0, 20))
    const batches: Array<{ events: unknown[] }> = []
    tails.push(tailAcpLog(ref, (events) => batches.push({ events }), { intervalMs: 20 }))
    await until(() => batches.length > 0)
    // A pass can land mid-line while acpd is appending.
    expect(batches[0].events).toEqual([])

    await fs.appendFile(file, full.slice(20) + '\n')
    await until(() => batches.some((b) => b.events.length > 0))
  })

  it('starts over when the record is truncated for a new agent life', async () => {
    const { file, ref } = await scratch()
    await fs.writeFile(file, [
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old life' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } }),
    ].join('\n') + '\n')
    // Rebuild the pane's view (replace on reset, else append), since a pass
    // may see the truncated file empty and report the reset with no events.
    let view: Array<{ content?: Array<{ text?: string }> }> = []
    tails.push(tailAcpLog(ref, (events, reset) => {
      const batch = events as typeof view
      view = reset ? batch : [...view, ...batch]
    }, { intervalMs: 20 }))
    await until(() => view.length === 2)

    // A restart truncates the log; appending from the old offset would mix
    // two runs.
    await fs.writeFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new life' } }) + '\n')
    await until(() => view.length === 1)
    expect(view[0]).toMatchObject({ content: [{ text: 'new life' }] })

    // The old run must not reappear on a later pass.
    await new Promise((r) => setTimeout(r, 100))
    expect(view).toHaveLength(1)
  })

  it('still reports the restart when it catches the record empty', async () => {
    // acpd's open(…, 'w') empties the file first, so a pass can see size 0.
    // The reset must still be reported.
    const { file, ref } = await scratch()
    await fs.writeFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old life' } }) + '\n')
    const batches: Array<{ events: unknown[]; reset: boolean }> = []
    tails.push(tailAcpLog(ref, (events, reset) => batches.push({ events, reset }), { intervalMs: 20 }))
    await until(() => batches.length > 0)

    await fs.truncate(file, 0)
    await until(() => batches.length > 1)
    expect(batches[1]).toEqual({ events: [], reset: true })

    await fs.appendFile(file, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new life' } }) + '\n')
    await until(() => batches.length > 2)
    // An ordinary append, not a second reset.
    expect(batches[2]).toMatchObject({ reset: false })
    expect(batches[2].events).toHaveLength(1)
  })

  it('holds a character split across a pass boundary', async () => {
    // Chunks can split a UTF-8 sequence; decoding each pass separately would
    // insert U+FFFD into JSON that still parses.
    const { file, ref } = await scratch()
    const full = Buffer.from(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'héllo 😀 世界' } }) + '\n',
      'utf8',
    )
    const at = full.indexOf(Buffer.from('😀', 'utf8')) + 2
    await fs.writeFile(file, full.subarray(0, at))

    const events: Array<{ content?: Array<{ text?: string }> }> = []
    tails.push(tailAcpLog(ref, (batch) => events.push(...batch as typeof events), { intervalMs: 20 }))
    await until(() => events.length === 0)
    await new Promise((r) => setTimeout(r, 60))

    await fs.appendFile(file, full.subarray(at))
    await until(() => events.length > 0)
    expect(events[0].content?.[0].text).toBe('héllo 😀 世界')
  })

  it('starts over when a new life reuses the byte count of the one before', async () => {
    // A restart's session/load replay can regrow the file past the old
    // offset within one tick, so only the run id reveals the truncation.
    const { file, ref } = await scratch()
    const a = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } })
    await fs.writeFile(file, [life('life-1'), a].join('\n') + '\n')

    let view: Array<{ content?: Array<{ text?: string }> }> = []
    tails.push(tailAcpLog(ref, (batch, reset) => {
      view = reset ? batch as typeof view : [...view, ...batch as typeof view]
    }, { intervalMs: 20 }))
    await until(() => view.length === 1)

    // Same size, different run.
    const b = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new' } })
    await fs.writeFile(file, [life('life-2'), b].join('\n') + '\n')
    await until(() => view.length === 1 && view[0].content?.[0].text === 'new')
  })

  it('flushes what has been appended even while a pass is already running', async () => {
    // The bridge relies on flush() to send a turn-end after the log's last
    // bytes, even when a timed pass is already running.
    const { file, ref } = await scratch()
    await fs.writeFile(file, '')
    const events: unknown[] = []
    const tail = tailAcpLog(ref, (batch) => events.push(...batch), { intervalMs: 20 })
    tails.push(tail)
    await until(() => events.length === 0)

    await fs.appendFile(file, update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the last words' },
    }) + '\n')
    await tail.flush()
    // Already there when flush resolves.
    expect(events).toHaveLength(1)
  })

  it('follows no record past the cap, whatever size it claims', async () => {
    // A huge sparse file is cheap to create but costly to read.
    const { file, ref } = await scratch()
    const handle = await fs.open(file, 'w')
    await handle.truncate(MAX_ACP_RECORD_BYTES + 1)
    await handle.close()
    const batches: Array<{ events: unknown[]; reset: boolean }> = []
    tails.push(tailAcpLog(ref, (events, reset) => batches.push({ events, reset }), { intervalMs: 20 }))
    await until(() => batches.length > 0)
    expect(batches[0]).toEqual({ events: [], reset: true })
  })

  it('stops reading once closed', async () => {
    const { file, ref } = await scratch()
    await fs.writeFile(file, '')
    const batches: unknown[] = []
    const tail = tailAcpLog(ref, (events) => batches.push(events), { intervalMs: 20 })
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
    // The reconciler labels workspaces from this, so it must read from disk.
    const { file, ref } = await record()
    await fs.writeFile(file, [
      line({ jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } }),
      line({ jsonrpc: '2.0', id: 'x-1', method: 'initialize', params: {} }),
      prompt('the founding ask'),
      prompt('a later one'),
    ].join('\n') + '\n')

    expect(await readAcpFirstPrompt(ref)).toBe('the founding ask')
  })

  it('labels from an opening message whose images run it past the scan', async () => {
    // Too large to parse, but the text precedes the images on the line.
    const { file, ref } = await record()
    await fs.writeFile(file, [
      life('life-1'),
      line({
        jsonrpc: '2.0',
        id: 'x-2',
        method: 'session/prompt',
        params: {
          sessionId: 'acp-1',
          prompt: [
            { type: 'text', text: 'why is "this" red?' },
            { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) },
          ],
        },
      }),
    ].join('\n') + '\n')

    expect(await readAcpFirstPrompt(ref)).toBe('why is "this" red?')
  })

  it('answers undefined for a record with no prompt, or none at all', async () => {
    const { file, ref } = await record()
    await fs.writeFile(file, update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'unprompted' },
    }) + '\n')

    expect(await readAcpFirstPrompt(ref)).toBeUndefined()
    expect(await readAcpFirstPrompt((await record()).ref)).toBeUndefined()
  })
})

/**
 * How a reconnecting server learns the agent is waiting on a permission
 * answer. acpd does not replay asks, so the log is the only record.
 */
describe('readAcpPendingPermissions', () => {
  const write = async (lines: string[]): Promise<AcpRecordRef> => {
    const { file, ref } = await record()
    await fs.writeFile(file, lines.join('\n') + '\n')
    return ref
  }

  it('returns an unanswered ask with the id the agent used, type included', async () => {
    // JSON-RPC matches ids by value and type, so 42 must not become "42".
    const file = await write([life('l1'), prompt('go'), ask(42)])
    expect(await readAcpPendingPermissions(file)).toEqual([42])

    const strung = await write([life('l1'), ask('req-9')])
    expect(await readAcpPendingPermissions(strung)).toEqual(['req-9'])
  })

  it('answers empty once the ask has been settled, or when there was never one', async () => {
    const settled = await write([life('l1'), ask(1), answer(1, 'allow')])
    expect(await readAcpPendingPermissions(settled)).toEqual([])

    const quiet = await write([life('l1'), prompt('go')])
    expect(await readAcpPendingPermissions(quiet)).toEqual([])
    expect(await readAcpPendingPermissions((await record()).ref)).toEqual([])
  })

  it('forgets asks the agent died holding, which nobody can answer any more', async () => {
    // acpd's exit line ends every pending ask of that run.
    const file = await write([
      life('l1'),
      ask(1),
      line({ jsonrpc: '2.0', method: '_acpd/exit', params: { code: 1, signal: null } }),
    ])
    expect(await readAcpPendingPermissions(file)).toEqual([])
  })

  it('reports every ask of a batch the agent is holding at once', async () => {
    const file = await write([life('l1'), ask(1), ask(2), ask(3), answer(2, 'allow')])
    expect(await readAcpPendingPermissions(file)).toEqual([1, 3])
  })
})

describe('replayAcpLog', () => {
  it('reads a record', () => {
    const events = replayAcpLog([
      line({ jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } }),
      prompt('do it'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }),
    ].join('\n') + '\n')
    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('marks each run an adapter reports starting, so a self-started reply stands apart', () => {
    const state = (s: string): string => line({
      jsonrpc: '2.0',
      method: '_claude/sdkMessage',
      params: { sessionId: 'acp-1', message: { type: 'system', subtype: 'session_state_changed', state: s } },
    })
    const text = (t: string): string => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
    const events = replayAcpLog([
      prompt('run it in the background'),
      state('running'), text('started'), state('idle'),
      // The background task finishing wakes the agent with no prompt.
      state('running'), text('finished'), state('idle'),
    ].join('\n') + '\n')
    expect(events.map((e) => e.type)).toEqual(['user', 'agent-turn', 'agent', 'agent-turn', 'agent'])
  })

  it('replays a message\'s images with its words', () => {
    // User turns exist only as `session/prompt` lines, images included.
    const raw = (line({
      jsonrpc: '2.0',
      id: 'abc-1',
      method: 'session/prompt',
      params: {
        sessionId: 'acp-1',
        prompt: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    }) + '\n')

    expect(replayAcpLog(raw)).toMatchObject([{
      type: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      ],
    }])
  })

  it('reconstructs user turns from the client\'s own prompts', () => {
    // The agent echoes user messages only on `session/load`, so live turns
    // come from these request lines.
    const events = replayAcpLog([
      prompt('first ask'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } }),
      prompt('second ask'),
    ].join('\n'))

    expect(events.map((e) => e.type)).toEqual(['user', 'agent', 'user'])
    expect(events[0]).toMatchObject({ content: [{ type: 'text', text: 'first ask' }] })
    expect(events[2]).toMatchObject({ content: [{ type: 'text', text: 'second ask' }] })
  })

  it('gives each subagent its own thread and follows subagents and tasks to their latest state', () => {
    // Shapes as claude's adapter sends them once yaac opts into its AIR
    // extension: a subagent's updates arrive under its own session id.
    const under = (sessionId: string, u: unknown): string =>
      line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
    const events = replayAcpLog([
      prompt('look around'),
      under('acp-1', {
        sessionUpdate: 'subagent_spawned', subagentSessionId: 'sub-1', name: 'Explore', task: 'find the router',
      }),
      under('sub-1', { sessionUpdate: 'tool_call', toolCallId: 's1', title: 'grep router', kind: 'search', status: 'pending' }),
      under('sub-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'found it' } }),
      line({
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: { sessionId: 'sub-1', toolCall: { toolCallId: 's2', title: 'rm x' }, options: [] },
      }),
      // The adapter hides the Agent call that spawned the subagent, but still
      // sends it a bare update.
      under('acp-1', { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_hidden' }),
      under('acp-1', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'sub-1', state: 'completed' }),
      under('acp-1', {
        sessionUpdate: 'async_task_spawned', asyncTaskId: 'b1', name: 'npm run dev', taskType: 'shell',
        description: 'npm run dev', toolCallId: 't9', canStop: true,
      }),
      under('acp-1', { sessionUpdate: 'async_task_progress', asyncTaskId: 'b1', outputFilePath: '/tmp/c/tasks/b1.output' }),
      under('acp-1', { sessionUpdate: 'async_task_state_update', asyncTaskId: 'b1', state: 'stopped' }),
      // An update for a task never announced has nothing to merge onto.
      under('acp-1', { sessionUpdate: 'async_task_state_update', asyncTaskId: 'ghost', state: 'failed' }),
      under('acp-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
    ].join('\n'))

    expect(events.map((e) => [e.type, 'thread' in e ? e.thread : undefined])).toEqual([
      ['user', undefined],
      ['subagent', undefined],
      ['tool', 'sub-1'],
      ['agent', 'sub-1'],
      ['permission-request', 'sub-1'],
      ['subagent', undefined],
      ['task', undefined],
      ['task', undefined],
      ['task', undefined],
      ['agent', undefined],
    ])
    expect(events[5]).toMatchObject({
      subagent: { id: 'sub-1', name: 'Explore', task: 'find the router', state: 'completed' },
    })
    expect(events[8]).toMatchObject({
      task: {
        id: 'b1', name: 'npm run dev', kind: 'shell', state: 'stopped', toolCallId: 't9',
        outputFile: '/tmp/c/tasks/b1.output',
      },
    })
  })

  it('gives an opencode subagent its own thread from opencode\'s child-session notifications', () => {
    // Shapes as opencode 2 sends them once yaac opts in.
    const child = (params: Record<string, unknown>): string => line({
      jsonrpc: '2.0',
      method: 'opencode/session/child_update',
      params: { rootSessionId: 'ses_root', childSessionId: 'ses_kid', parentSessionId: 'ses_root', depth: 1, title: 'list files', ...params },
    })
    const events = replayAcpLog([
      child({ type: 'status', status: 'created' }),
      child({ type: 'status', status: 'running' }),
      child({
        type: 'update',
        update: { sessionUpdate: 'tool_call', toolCallId: 'ses_kid:call_2', title: 'list files: shell', kind: 'execute', status: 'pending' },
      }),
      child({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two files' } } }),
      child({ type: 'status', status: 'interrupted' }),
    ].join('\n'))

    expect(events.map((e) => [e.type, 'thread' in e ? e.thread : undefined])).toEqual([
      ['subagent', undefined],
      ['tool', 'ses_kid'],
      ['agent', 'ses_kid'],
      ['subagent', undefined],
    ])
    expect(events[0]).toMatchObject({ subagent: { id: 'ses_kid', name: 'list files', state: 'running' } })
    expect(events[3]).toMatchObject({ subagent: { id: 'ses_kid', state: 'cancelled' } })
  })

  it('projects a command\'s streamed terminal output as deltas, so a replay grows with the output, not its square', () => {
    // codex streams a command's output, a background shell's included, as
    // `terminal_output_delta` chunks on its call.
    const delta = (data: string): string => update({
      sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', _meta: { terminal_output_delta: { data, terminal_id: 'exec-1' } },
    })
    const record = (chunks: number): string => [
      // The terminal content names a terminal yaac never created, so it adds nothing.
      update({
        sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'tick', kind: 'execute', status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'exec-1' }],
      }),
      ...Array.from({ length: chunks }, (_, i) => delta(`# tick ${String(i)}\n`)),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'completed' }),
    ].join('\n')

    const events = replayAcpLog(record(2))
    expect(events.map((e) => e.type)).toEqual(['tool', 'tool-output', 'tool-output', 'tool'])
    expect(events[1]).toMatchObject({ toolCallId: 'exec-1', data: '# tick 0\n' })
    // The output stays out of the call's content, which is rendered as Markdown.
    expect(events[3]).toMatchObject({ call: { toolCallId: 'exec-1', status: 'completed' } })
    expect(events[3]).not.toHaveProperty('call.content')

    const size = (chunks: number): number => JSON.stringify(replayAcpLog(record(chunks))).length
    expect(size(2000) / size(1000)).toBeLessThan(2.1)
  })

  it('builds claude\'s subagents and background shells from the Agent SDK messages it forwards', () => {
    // Shapes as claude-agent-acp 0.84.0 sends them to a client that is not
    // AIR, with the task messages asked for in the session's `_meta`.
    const sdk = (message: Record<string, unknown>): string =>
      line({ jsonrpc: '2.0', method: '_claude/sdkMessage', params: { sessionId: 'acp-1', message: { type: 'system', ...message } } })
    const claudeUpdate = (u: Record<string, unknown>, claudeCode: Record<string, unknown>): string =>
      update({ ...u, _meta: { claudeCode } })
    const events = replayAcpLog([
      claudeUpdate({ sessionUpdate: 'tool_call', toolCallId: 'toolu_bash', title: 'tick loop', kind: 'execute', status: 'pending' }, { toolName: 'Bash' }),
      claudeUpdate({ sessionUpdate: 'tool_call', toolCallId: 'toolu_agent', title: 'count files', kind: 'think', status: 'pending' }, { toolName: 'Agent' }),
      sdk({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash' }] }),
      sdk({ subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', description: 'Print ticks', is_backgrounded: true, task_type: 'local_bash' }),
      sdk({
        subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_agent', description: 'count files',
        subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent', prompt: 'Run ls',
      }),
      // A foreground command is a task too, but is not shown.
      sdk({ subtype: 'task_started', task_id: 'f1', tool_use_id: 'toolu_fg', description: 'npm test', is_backgrounded: false, task_type: 'local_bash' }),
      claudeUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'toolu_bash', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Command running in background with ID: b1. Output is being written to: /tmp/c/tasks/b1.output. You will be notified when it completes.' } }],
      }, { toolName: 'Bash' }),
      claudeUpdate({ sessionUpdate: 'tool_call', toolCallId: 'toolu_ls', title: 'ls', kind: 'execute', status: 'pending' }, { toolName: 'Bash', parentToolUseId: 'toolu_agent' }),
      sdk({ subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_agent', status: 'completed', summary: 'two files' }),
      sdk({ subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_bash', status: 'completed', output_file: '/tmp/c/tasks/b1.output' }),
    ].join('\n'))

    expect(events.map((e) => [e.type, 'thread' in e ? e.thread : undefined])).toEqual([
      ['tool', undefined],
      ['tool', undefined],
      ['task', undefined],
      ['subagent', undefined],
      ['tool', undefined],
      ['task', undefined],
      ['tool', 'toolu_agent'],
      ['subagent', undefined],
      ['task', undefined],
    ])
    // No Stop: claude stops a task only for an AIR client.
    expect(events[2]).toEqual({
      type: 'task',
      seq: 2,
      task: { id: 'b1', name: 'Print ticks', kind: 'shell', description: 'Print ticks', state: 'running', toolCallId: 'toolu_bash' },
    })
    expect(events[3]).toMatchObject({ subagent: { id: 'toolu_agent', name: 'count files', task: 'Run ls', state: 'running' } })
    // The output file named in the call's result.
    expect(events[5]).toMatchObject({ task: { id: 'b1', outputFile: '/tmp/c/tasks/b1.output', state: 'running' } })
    expect(events[7]).toMatchObject({ subagent: { id: 'toolu_agent', state: 'completed', summary: 'two files' } })
    expect(events[8]).toMatchObject({ task: { id: 'b1', state: 'completed' } })
  })

  it('shows a claude Monitor as a monitor, and marks an artifact watch ambient', () => {
    // As claude-agent-acp 0.84.0 (claude 2.1.284) sends them: the Monitor
    // call comes first, then its task, which claude reports as a backgrounded
    // shell; the live set comes before each task's own start and end.
    const sdk = (message: Record<string, unknown>): string =>
      line({ jsonrpc: '2.0', method: '_claude/sdkMessage', params: { sessionId: 'acp-1', message: { type: 'system', ...message } } })
    const claudeUpdate = (u: Record<string, unknown>, claudeCode: Record<string, unknown>): string =>
      update({ ...u, _meta: { claudeCode } })
    const command = 'yaac-watch-prs --pr 306 --events comment'
    const events = replayAcpLog([
      claudeUpdate({
        sessionUpdate: 'tool_call', toolCallId: 'toolu_mon', name: 'Monitor', rawInput: {}, status: 'pending',
        title: 'Monitor', kind: 'other', content: [],
      }, { toolName: 'Monitor' }),
      claudeUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'toolu_mon', title: 'Monitor', kind: 'other',
        rawInput: { command, description: 'PR 306 comments', persistent: true },
        content: [{ type: 'content', content: { type: 'text', text: '```json\n{}\n```' } }],
      }, { toolName: 'Monitor' }),
      claudeUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'toolu_wsmon', title: 'Monitor', kind: 'other', status: 'completed',
        rawInput: { ws: { url: 'wss://events.example.com' }, description: 'deploy events' },
      }, { toolName: 'Monitor' }),
      sdk({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'bmon', task_type: 'local_bash', description: 'PR 306 comments' }] }),
      sdk({
        subtype: 'task_started', task_id: 'bmon', tool_use_id: 'toolu_mon', description: 'PR 306 comments',
        is_backgrounded: true, task_type: 'local_bash',
      }),
      claudeUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'toolu_mon', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Monitor started (task bmon, persistent). You will be notified on each event.' } }],
      }, { toolName: 'Monitor', toolResponse: { taskId: 'bmon', timeoutMs: 0, persistent: true } }),
      sdk({
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'bmon', task_type: 'local_bash', description: 'PR 306 comments' },
          { task_id: 'ws1', task_type: 'monitor_ws', description: 'artifact updates', ambient: true },
        ],
      }),
      sdk({ subtype: 'task_started', task_id: 'ws1', description: 'artifact updates', task_type: 'monitor_ws', ambient: true }),
      sdk({ subtype: 'task_progress', task_id: 'bmon', tool_use_id: 'toolu_mon', description: 'PR 306 comments', usage: {} }),
      sdk({ subtype: 'background_tasks_changed', tasks: [] }),
      sdk({ subtype: 'task_updated', task_id: 'bmon', patch: { status: 'killed', end_time: 1 } }),
      sdk({
        subtype: 'task_notification', task_id: 'bmon', tool_use_id: 'toolu_mon', status: 'stopped',
        output_file: '/tmp/c/tasks/bmon.output', summary: 'Monitor "PR 306 comments" stopped',
      }),
    ].join('\n'))

    // The call is shown as the command it watches, once one arrives; a
    // WebSocket Monitor has none and stays a "Monitor" call.
    const calls = events.flatMap((e) => (e.type === 'tool' ? [e.call] : []))
    expect(calls[0]).toMatchObject({ title: 'Monitor', kind: 'other', status: 'pending' })
    const wsCall = calls.find((c) => c.toolCallId === 'toolu_wsmon')
    expect(wsCall).toMatchObject({ title: 'Monitor', kind: 'other' })
    expect(wsCall?.shell).toBeUndefined()
    expect(calls.filter((c) => c.toolCallId === 'toolu_mon').at(-1)).toMatchObject({
      title: command, shell: true, description: 'PR 306 comments', kind: 'execute', status: 'completed',
    })
    const all = events.flatMap((e) => (e.type === 'task' ? [e.task] : []))
    // The artifact watch is shown, marked as no activity of the agent's.
    expect(all.find((t) => t.id === 'ws1')).toMatchObject({ kind: 'monitor', ambient: true, state: 'running' })
    const tasks = all.filter((t) => t.id === 'bmon')
    expect(tasks[0]).toEqual({
      id: 'bmon', name: 'PR 306 comments', kind: 'monitor', description: 'PR 306 comments', state: 'running', toolCallId: 'toolu_mon',
    })
    // A live set that lists it leaves it running; it ends once dropped.
    expect(tasks.map((t) => t.state)).toEqual(['running', 'running', 'stopped', 'stopped', 'stopped'])
    expect(tasks.at(-1)).toMatchObject({
      kind: 'monitor', state: 'stopped', outputFile: '/tmp/c/tasks/bmon.output', summary: 'Monitor "PR 306 comments" stopped',
    })
  })

  it('stops a claude task the live set drops, though its end was never reported', () => {
    const sdk = (message: Record<string, unknown>): string =>
      line({ jsonrpc: '2.0', method: '_claude/sdkMessage', params: { sessionId: 'acp-1', message: { type: 'system', ...message } } })
    const events = replayAcpLog([
      sdk({ subtype: 'task_started', task_id: 'm1', description: 'watch logs', task_type: 'monitor_mcp' }),
      sdk({ subtype: 'background_tasks_changed', tasks: [] }),
    ].join('\n'))
    expect(events.map((e) => (e.type === 'task' ? [e.task.kind, e.task.state] : e.type))).toEqual([
      ['monitor', 'running'],
      ['monitor', 'stopped'],
    ])
  })

  it('ends a background claude subagent the live set drops, but not a foreground one', () => {
    const sdk = (message: Record<string, unknown>): string =>
      line({ jsonrpc: '2.0', method: '_claude/sdkMessage', params: { sessionId: 'acp-1', message: { type: 'system', ...message } } })
    const start = (taskId: string, toolUseId: string, backgrounded: boolean): string => sdk({
      subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, task_type: 'local_agent',
      description: taskId, prompt: 'go', is_backgrounded: backgrounded,
    })
    const events = replayAcpLog([
      start('bg', 'agent-bg', true),
      start('fg', 'agent-fg', false),
      start('moved', 'agent-moved', false),
      sdk({ subtype: 'task_updated', task_id: 'moved', patch: { is_backgrounded: true } }),
      sdk({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'moved' }] }),
      sdk({ subtype: 'background_tasks_changed', tasks: [] }),
      sdk({ subtype: 'task_notification', task_id: 'bg', status: 'completed', summary: 'done' }),
    ].join('\n'))
    expect(events.map((e) => (e.type === 'subagent' ? [e.subagent.id, e.subagent.state] : e.type))).toEqual([
      ['agent-bg', 'running'],
      ['agent-fg', 'running'],
      ['agent-moved', 'running'],
      ['agent-bg', 'cancelled'],
      ['agent-moved', 'cancelled'],
      ['agent-bg', 'completed'],
    ])
  })

  it('renders a call whose first report is its completion, as codex sends one replayed from an earlier life', () => {
    const events = replayAcpLog(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-9', name: 'exec_command', kind: 'execute', status: 'completed',
    }))
    expect(events).toMatchObject([{ type: 'tool', call: { toolCallId: 'call-9', status: 'completed' } }])
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
    // Uses the same `mergeToolCall` as the live path.
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
    // The update carried only a status; the rest is inherited.
    expect(events[1]).toMatchObject({
      call: { toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'completed' },
    })
  })

  it('marks shell calls by their rawInput, and pi\'s by having none, keeping claude\'s description', () => {
    const events = replayAcpLog([
      // claude: the command arrives in rawInput, the title later.
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'claude',
        title: 'Terminal',
        kind: 'execute',
        rawInput: { command: 'ls -la', description: 'List files' },
      }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'claude', title: 'ls -la', status: 'completed' }),
      // pi: a bash call carries no rawInput at all.
      update({ sessionUpdate: 'tool_call', toolCallId: 'pi', title: 'git status', kind: 'execute' }),
      // codex: an MCP call is filed under execute, with a rawInput but no command.
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp',
        title: 'mcp.github.get_issue',
        kind: 'execute',
        rawInput: { server: 'github', tool: 'get_issue', arguments: { number: 1 } },
      }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'mcp', status: 'completed' }),
      // claude and opencode pass an MCP tool's input through, under kind other.
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'claude-mcp',
        title: 'mcp__sandbox__execute_command',
        kind: 'other',
        rawInput: { command: 'ls' },
      }),
    ].join('\n'))

    const calls = events.map((e) => (e as { call: { toolCallId: string; shell?: true; description?: string } }).call)
    expect(calls.map((c) => [c.toolCallId, c.shell, c.description])).toEqual([
      ['claude', true, 'List files'], ['claude', true, 'List files'], ['pi', true, undefined],
      ['mcp', undefined, undefined], ['mcp', undefined, undefined], ['claude-mcp', undefined, undefined],
    ])
  })

  it('projects the commands and models the session offers, and each model switch', () => {
    // Shapes as the pinned adapters send them: claude's `model` config
    // option, codex's `models` block whose ids carry an effort (the config
    // option wins), and a command list with an argument hint.
    const modelOption = (current: string): unknown => ({
      id: 'model',
      type: 'select',
      currentValue: current,
      options: [
        { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
        { value: 'sonnet', name: 'Sonnet 5', description: null },
      ],
    })
    const events = replayAcpLog([
      line({ jsonrpc: '2.0', id: 'x-1', method: 'session/new', params: { cwd: '/workspace' } }),
      line({
        jsonrpc: '2.0',
        id: 'x-1',
        result: {
          sessionId: 'acp-1',
          models: { currentModelId: 'default[low]', availableModels: [{ modelId: 'default[low]' }] },
          configOptions: [{ id: 'mode', currentValue: 'default', options: [] }, modelOption('default')],
        },
      }),
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Summarize', input: { hint: '<instructions>' } },
          { name: 'review-pr', description: '', input: null },
        ],
      }),
      line({ jsonrpc: '2.0', id: 'x-2', method: 'session/set_config_option', params: { configId: 'model', value: 'sonnet' } }),
      line({ jsonrpc: '2.0', id: 'x-2', result: { configOptions: [modelOption('sonnet')] } }),
      // A reply to a mode switch carries no model.
      line({ jsonrpc: '2.0', id: 'x-3', result: {} }),
    ].join('\n'))

    expect(events.map((e) => e.type)).toEqual(['models', 'commands', 'models'])
    expect(events[0]).toMatchObject({
      current: 'default',
      models: [
        { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5' },
        { id: 'sonnet', name: 'Sonnet 5' },
      ],
    })
    expect(events[1]).toMatchObject({
      commands: [{ name: 'compact', description: 'Summarize', hint: '<instructions>' }, { name: 'review-pr' }],
    })
    expect(events[2]).toMatchObject({ current: 'sonnet' })
  })

  it('ignores the lines that carry no conversation content', () => {
    const events = replayAcpLog([
      line({ jsonrpc: '2.0', method: '_acpd/life', params: { id: 'life-1' } }),
      line({ jsonrpc: '2.0', id: 'x-1', method: 'initialize', params: {} }),
      line({ jsonrpc: '2.0', id: 'x-1', result: { protocolVersion: 1 } }),
      line({ jsonrpc: '2.0', id: 'x-2', method: 'session/new', params: { cwd: '/workspace' } }),
      line({ jsonrpc: '2.0', id: 'x-2', result: { workspaceId: 'acp-1' } }),
      line({ jsonrpc: '2.0', method: '_acpd/hello', params: { firstAttach: true } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'only this' } }),
    ].join('\n'))

    expect(events.map((e) => e.type)).toEqual(['agent'])
  })

  it('survives a partial trailing line, which a live record always has', () => {
    const raw = [
      prompt('go'),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
    ].join('\n') + '\n' + '{"jsonrpc":"2.0","method":"session/upda'

    const events = replayAcpLog(raw)
    expect(events.map((e) => e.type)).toEqual(['user', 'agent'])
  })

  it('projects a permission ask and the answer that settled it', () => {
    // The log records both directions, including asks the server answered
    // itself under `bypass`.
    const events = replayAcpLog([
      prompt('clean the build'),
      ask(42),
      answer(42, 'allow'),
    ].join('\n'))

    expect(events.map((e) => e.type)).toEqual(['user', 'permission-request', 'permission-resolved'])
    expect(events[1]).toMatchObject({
      requestId: '42',
      toolCall: { toolCallId: 'call-1', title: 'rm -rf build', kind: 'execute' },
      options: [
        { optionId: 'no', name: 'Deny', kind: 'reject_once' },
        { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
      ],
    })
    expect(events[2]).toMatchObject({ requestId: '42', outcome: 'selected', optionId: 'allow' })
  })

  it('leaves an unanswered ask unresolved, which is what a pane renders as pending', () => {
    const events = replayAcpLog([prompt('go'), ask(1)].join('\n'))
    expect(events.map((e) => e.type)).toEqual(['user', 'permission-request'])
  })

  it('reads a dismissal as cancelled, and ignores a reply to something else', () => {
    const events = replayAcpLog([
      // A reply to a non-permission request (e.g. the handshake).
      line({ jsonrpc: '2.0', id: 'x-1', result: { protocolVersion: 1 } }),
      ask(7),
      answer(7),
    ].join('\n'))
    expect(events.map((e) => e.type)).toEqual(['permission-request', 'permission-resolved'])
    expect(events[1]).toMatchObject({ requestId: '7', outcome: 'cancelled' })
  })

  it('skips adapter noise rather than losing the conversation around it', () => {
    const events = replayAcpLog([
      'warning: some adapter banner',
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } }),
    ].join('\n'))
    expect(events.map((e) => e.type)).toEqual(['agent'])
  })

  it('hands an edit to the pane as a diff, not as prose about one', () => {
    // One before/after entry per hunk; the pane renders each as a diff.
    const events = replayAcpLog([
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Edit a.ts',
        kind: 'edit',
        content: [
          { type: 'diff', path: '/workspace/a.ts', oldText: 'one', newText: 'ONE' },
          // `null` means a new file, not the text "null".
          { type: 'diff', path: '/workspace/b.ts', oldText: null, newText: 'fresh' },
        ],
      }),
    ].join('\n'))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      call: {
        content: [
          { type: 'diff', path: '/workspace/a.ts', oldText: 'one', newText: 'ONE' },
          { type: 'diff', path: '/workspace/b.ts', newText: 'fresh' },
        ],
      },
    })
    const created = (events[0] as { call: { content: Array<Record<string, unknown>> } }).call.content[1]
    expect('oldText' in created).toBe(false)
  })

  it('carries a tool call’s prose and its edits side by side', () => {
    const events = replayAcpLog([
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Write a.ts',
        kind: 'edit',
        content: [
          { type: 'content', content: { type: 'text', text: 'writing the file' } },
          { type: 'diff', path: '/workspace/a.ts', newText: 'body' },
          // yaac provides no terminals, so there is nothing to show.
          { type: 'terminal', terminalId: 'term-1' },
        ],
      }),
    ].join('\n'))

    expect(events[0]).toMatchObject({
      call: {
        content: [
          { type: 'text', text: 'writing the file' },
          { type: 'diff', path: '/workspace/a.ts', newText: 'body' },
        ],
      },
    })
  })
})
