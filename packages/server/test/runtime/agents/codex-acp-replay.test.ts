import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { codexTranscriptAsAcp } from '#runtime/agents/codex-acp-replay'
import type { AcpEvent, AcpToolCall } from '@yaac/shared/acp'

/**
 * A tui codex conversation replayed as ACP events. The rollouts in
 * replay-fixtures/codex/ are real codex 0.159.3 rollouts (cut to the lines the
 * replay reads, cwd set to /workspace/app), recorded by driving the pinned
 * codex-acp against a scripted model. session.jsonl runs every tool codex
 * has in direct-call and code mode, a steer, a background command, a
 * stopped turn, a failed request, plan mode, compactions and a review (whose
 * own thread is session-review.jsonl); agents.jsonl spawns subagents (the
 * other agents-*.jsonl): one it waits on and follows up, one it
 * interrupts, and one still working when the turn is stopped. The
 * expectations are what replaying codex-acp's live record of the same
 * prompts projects to.
 */

const rollout = (name: string): string => fs.readFileSync(new URL(`replay-fixtures/codex/${name}`, import.meta.url), 'utf8')
const SESSION = [rollout('session.jsonl'), rollout('session-review.jsonl')]
const AGENTS = ['agents.jsonl', 'agents-helper.jsonl', 'agents-slow-one.jsonl', 'agents-slow-two.jsonl'].map(rollout)
const HELPER = '01a11125-0022-71b3-a218-fb2ca56acee1'
const SLOW_TWO = '01a11125-1a9d-7281-9ba0-307bd0d31682'

/** Each tool call at its latest state, with the output streamed to it. */
function toolCalls(events: AcpEvent[]): Map<string, AcpToolCall & { output: string }> {
  const calls = new Map<string, AcpToolCall & { output: string }>()
  for (const e of events) {
    if (e.type === 'tool') calls.set(e.call.toolCallId, { ...e.call, output: calls.get(e.call.toolCallId)?.output ?? '' })
    if (e.type === 'tool-output') calls.get(e.toolCallId)!.output += e.data
  }
  return calls
}

/** The conversation's text and turn boundaries, in order. */
function conversation(events: AcpEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.type === 'agent-turn') return ['--']
    if (e.type !== 'user' && e.type !== 'agent' && e.type !== 'thought') return []
    const text = e.content.map((c) => (c.type === 'text' ? c.text : `[${c.mimeType}]`)).join('')
    const thread = e.thread === undefined ? '' : ' (subagent)'
    return [`${e.type}${e.type === 'user' && e.steered ? ' (steered)' : ''}${thread}: ${text.trim().split('\n')[0]}`]
  })
}

describe('codexTranscriptAsAcp', () => {
  it('replays a conversation as the events an acp pane renders', () => {
    const events = codexTranscriptAsAcp(SESSION)

    expect(conversation(events)).toEqual([
      'user: t-basic please', '--',
      'thought: Thinking about the shell.',
      'agent: I will run commands.',
      'agent: Done with basics.',
      'user: t-multi please', '--', 'agent: Multi done.',
      'user: t-plan please', '--', 'agent: Planned.',
      'user: t-wait please', '--', 'user (steered): also this', 'agent: Waited.',
      'user: t-bg please', '--', 'agent: Started it in the background.',
      // Stopped: no reply.
      'user: t-wait please', '--',
      'user: t-error please', '--', 'agent: {"error":{"message":"fake bad request","type":"invalid_request_error"}}',
      // Switching model compacted first, inside the turn the prompt began.
      'user: t-patch please', '--', 'agent: Patched.',
      'user: t-mcp please', '--', 'agent: MCP done.',
      'user: t-web please', '--', 'agent: Searched.',
      'user: t-image please', '--', 'agent: Imaged.',
      'user: t-userimg look[image/png]', '--', 'agent: Nice picture.',
      'user: t-proposal please', '--', 'agent: Here is my plan.', 'agent: # Plan',
      'user: Implement the approved plan.', '--', 'agent: Here is my plan.',
      // `/compact` and `/review` leave no message; the review's own
      // thread is not shown, only its findings.
      '--', '--', 'agent: Two problems.',
    ])
    expect(events.find((e) => e.type === 'thought')).toMatchObject({
      content: [{ type: 'text', text: '\n\nThinking about the shell.\n\nSecond thought.' }],
    })

    const calls = toolCalls(events)
    expect(calls.get('call_1')).toMatchObject({ title: 'echo hello; echo world', kind: 'execute', shell: true, status: 'completed', output: 'hello\nworld\n' })
    expect(calls.get('call_2')).toMatchObject({ title: "Read file '/workspace/app/hello.txt'", kind: 'read', locations: [{ path: '/workspace/app/hello.txt' }], output: '' })
    expect(calls.get('call_3')).toMatchObject({ title: "Search for 'hello' in .", kind: 'search', output: '' })
    expect(calls.get('call_4')).toMatchObject({ title: 'List files', kind: 'read' })
    expect(calls.get('call_5')).toMatchObject({ title: 'echo oops >&2; exit 3', status: 'failed', output: 'oops\n' })
    expect(calls.get('call_9')).toMatchObject({ title: 'cat hello.txt; ls', shell: true, output: 'hello world\nhello.txt\nimg.png\n' })
    expect(calls.get('call_6')).toMatchObject({ title: 'sleep 4; echo bg-done', status: 'completed', output: 'bg-done\n' })

    const all = [...calls.values()]
    expect(all.filter((c) => c.kind === 'edit').map((c) => [c.status, c.content])).toEqual([
      ['completed', [{ type: 'diff', path: '/workspace/app/added.txt', newText: 'line one\nline two\n' }]],
      ['completed', [
        { type: 'diff', path: '/workspace/app/added.txt', oldText: 'line one\nline two\n', newText: '' },
        { type: 'diff', path: '/workspace/app/hello.txt', oldText: 'hello world\n', newText: 'hello there\n' },
        { type: 'diff', path: '/workspace/app/moved-src.txt', newText: 'moving\n' },
      ]],
      ['completed', [{ type: 'diff', path: '/workspace/app/moved-dst.txt', oldText: 'moving\n', newText: 'moved\n' }]],
    ])
    // An MCP tool is not a shell command for all its `execute` kind.
    expect(all.filter((c) => c.title === 'mcp.echo.echo').map((c) => [c.shell, c.status])).toEqual([
      [undefined, 'completed'], [undefined, 'failed'],
    ])
    expect(all.filter((c) => c.kind === 'search' && c.toolCallId.startsWith('ws')).map((c) => [c.title, c.status])).toEqual([
      ['Web search: yaac codex', 'completed'], ['Open page: https://example.com', 'completed'],
    ])
    expect(all.find((c) => c.title.startsWith('View Image'))).toMatchObject({
      title: 'View Image /workspace/app/img.png', kind: 'read', status: 'completed', locations: [{ path: '/workspace/app/img.png' }],
    })
    expect(all.filter((c) => c.title === 'Compact conversation').map((c) => [c.kind, c.status])).toEqual([
      ['think', 'completed'], ['think', 'completed'],
    ])

    expect(events.filter((e) => e.type === 'plan')).toMatchObject([{ entries: [
      { content: 'First', status: 'completed' }, { content: 'Second', status: 'in_progress' }, { content: 'Third', status: 'pending' },
    ] }])
    // A command still running when its turn ended, or when the turn was
    // stopped, is a background task until it exits.
    expect(events.flatMap((e) => (e.type === 'task' ? [[e.task.id, e.task.name, e.task.state]] : []))).toEqual([
      ['call_6', 'sleep 4; echo bg-done', 'running'],
      ['call_6', 'sleep 4; echo bg-done', 'completed'],
      ['call_7', 'sleep 5; echo waited', 'running'],
      ['call_7', 'sleep 5; echo waited', 'completed'],
    ])
    expect(events.filter((e) => e.type === 'usage').at(-1)).toMatchObject({ used: 5540, size: 258400 })
  })

  it('replays subagents under their own threads, in step with their parent', () => {
    const events = codexTranscriptAsAcp(AGENTS)

    expect(conversation(events)).toEqual([
      'user: t-followup please', '--',
      // A subagent reports its running state on the same channel.
      '--',
      'thought (subagent): Child thinking.',
      'agent (subagent): Hi from the child.',
      // Its follow-up turn is not shown: the adapter drops a finished
      // subagent's updates.
      'agent: Followed up.',
      'user: t-edge please', '--', 'agent: Edged.',
      'user: t-interrupt please', '--', 'agent: Interrupted it.',
      'user: t-cancelwait please', '--', '--',
    ])
    expect(events.flatMap((e) => (e.type === 'subagent' ? [[e.subagent.name, e.subagent.state]] : []))).toEqual([
      ['Helper', 'running'], ['Helper', 'completed'],
      ['Slow one', 'running'], ['Slow one', 'cancelled'],
      // Stopping the parent's turn ends it too.
      ['Slow two', 'running'], ['Slow two', 'cancelled'],
    ])
    expect(events.find((e) => e.type === 'subagent')).toMatchObject({
      subagent: { id: HELPER, task: 'Delegated task for Helper' },
    })

    // The parent's wait opens before the subagent works and closes after.
    const at = (match: (e: AcpEvent) => boolean): number => events.findIndex(match)
    const waitOpen = at((e) => e.type === 'tool' && e.call.toolCallId === 'call_21')
    const childFirst = at((e) => 'thread' in e && e.thread === HELPER)
    const childDone = at((e) => e.type === 'subagent' && e.subagent.state === 'completed')
    const waitDone = at((e) => e.type === 'tool' && e.call.toolCallId === 'call_21' && e.call.status === 'completed')
    expect([waitOpen < childFirst, childFirst < childDone, childDone < waitDone]).toEqual([true, true, true])

    const calls = toolCalls(events)
    expect(events.find((e) => e.type === 'tool' && e.call.toolCallId === 'call_8')).toMatchObject({
      thread: HELPER, call: { title: 'echo from-child', shell: true },
    })
    expect(calls.get('call_8')?.output).toBe('from-child\n')
    // A cancelled subagent's running command is a task; its call stays
    // where it was when the subagent's updates stopped.
    expect(calls.get('call_9')).toMatchObject({ title: 'sleep 3; echo slow', status: 'in_progress', output: '' })
    expect(events.flatMap((e) => (e.type === 'task' ? [[e.task.id, e.task.state]] : []))).toEqual([
      [`${SLOW_TWO}:call_9`, 'running'], [`${SLOW_TWO}:call_9`, 'completed'],
    ])

    const all = [...calls.values()]
    // A line with no newline at its end keeps it off.
    expect(all.find((c) => c.kind === 'edit')?.content).toEqual([
      { type: 'diff', path: '/workspace/app/nonl.txt', oldText: 'old', newText: 'new\n' },
    ])
    expect(all.filter((c) => c.kind === 'search').map((c) => c.title)).toEqual([
      "Find in page for 'yaac' in https://example.com", 'Web search',
    ])
  })

  it('shows an attached image file as the image the model was sent', () => {
    // `codex exec --image img.png`, as the TUI attaches a pasted image: the
    // message keeps the path, the model input before it the data.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const lines = [
      { timestamp: '2026-10-06T12:19:16.545Z', type: 'session_meta', payload: { id: '01a11127-6104-7890-a69d-3124d70e980d', cwd: '/workspace/app', originator: 'codex_exec', cli_version: '0.159.3', source: 'exec' } },
      { timestamp: '2026-10-06T12:19:16.546Z', type: 'event_msg', payload: { type: 'task_started', turn_id: '01a11127-62ce-7b01-b13a-fcb3ac6825c6' } },
      { timestamp: '2026-10-06T12:19:16.733Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '<image name=[Image #1] path="img.png">' },
        { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'high' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: 't-userimg via exec' },
      ] } },
      { timestamp: '2026-10-06T12:19:16.736Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: '01a11127-6104-7890-a69d-3124d70e980d', turn_id: '01a11127-62ce-7b01-b13a-fcb3ac6825c6', item: {
        type: 'UserMessage', id: '01a11127-647d-7621-acb2-acaa409efa31',
        content: [{ type: 'local_image', path: 'img.png' }, { type: 'text', text: 't-userimg via exec', text_elements: [] }],
      }, started_at_ms: 1791289156736, completed_at_ms: 1791289156736 } },
    ]
    const events = codexTranscriptAsAcp([lines.map((l) => JSON.stringify(l)).join('\n')])
    expect(events[0]).toMatchObject({
      type: 'user', content: [{ type: 'image', mimeType: 'image/png', data: png }, { type: 'text', text: 't-userimg via exec' }],
    })
  })

  it('stays linear on a crafted rollout of many turns and unfinished commands', () => {
    // Each command is still running at every later turn's end, which a scan
    // of all running commands per turn end makes quadratic.
    const thread = '01a1111c-de75-7ce3-8999-3257b2615db0'
    const at = (ms: number): string => new Date(ms).toISOString()
    const lines = [JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: thread } })]
    const n = 20_000
    for (let i = 0; i < n; i++) {
      const turn = `t${String(i)}`
      lines.push(
        JSON.stringify({ timestamp: at(10 * i + 1), type: 'event_msg', payload: { type: 'task_started', turn_id: turn } }),
        JSON.stringify({ timestamp: at(10 * i + 2), type: 'event_msg', payload: {
          type: 'item_completed', thread_id: thread, turn_id: turn,
          item: { type: 'CommandExecution', id: `c${String(i)}`, command: ['sleep', '1'], parsed_cmd: [], status: 'completed' },
          started_at_ms: 10 * i + 2, completed_at_ms: 10 * n + i,
        } }),
        JSON.stringify({ timestamp: at(10 * i + 3), type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } }),
      )
    }
    const started = Date.now()
    const events = codexTranscriptAsAcp([lines.join('\n')])
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(events.filter((e) => e.type === 'task')).toHaveLength(2 * n)
  })

  it('reads what it can of a damaged or missing history', () => {
    expect(codexTranscriptAsAcp([])).toEqual([])
    const [main] = SESSION
    const cut = main.indexOf('t-multi please')
    const events = codexTranscriptAsAcp([`not json\n${main.slice(0, cut)}`])
    expect(conversation(events)).toEqual([
      'user: t-basic please', '--', 'thought: Thinking about the shell.', 'agent: I will run commands.', 'agent: Done with basics.',
    ])
  })
})
