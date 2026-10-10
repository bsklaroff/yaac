import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { piTranscriptAsAcp } from '#runtime/agents/pi-acp-replay'
import type { AcpEvent, AcpToolCall } from '@yaac/shared/acp'

/**
 * A tui pi conversation replayed as ACP events. replay-fixtures/pi/session.jsonl is a real
 * pi 0.99.2 session (system prompt and usage trimmed, cwd set to
 * /workspace), recorded by driving the pinned pi-acp against a scripted
 * model: tool calls of every built-in kind, failures, an image, a failed
 * request, an abort, a compaction, a model switch, a steer, an extension's
 * messages, a user `!` command, and finally a `/tree` branch from the turn
 * after the compaction. The expectations are what replaying pi-acp's live
 * record of the same prompts projects to.
 */

const LINES = fs.readFileSync(new URL('replay-fixtures/pi/session.jsonl', import.meta.url), 'utf8').trimEnd().split('\n')
/** The log before the branch: its last entry is the user's `!` command. */
const LINEAR = LINES.slice(0, -3).join('\n')

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
    return [`${e.type}${e.type === 'user' && e.steered ? ' (steered)' : ''}: ${text.split('\n')[0]}`]
  })
}

describe('piTranscriptAsAcp', () => {
  it('replays a session as the events its live pi-acp stream projects to', () => {
    const events = piTranscriptAsAcp(LINEAR)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))

    // The failed request shows nothing, as live; the aborted one keeps what
    // streamed. The system prompt, model and thinking changes, the
    // extension's state and its hidden message stay out.
    expect(conversation(events)).toEqual([
      'user: TOOLS please', '--',
      'thought: Plan: run a command, then read.', 'agent: Running a command first.',
      'thought: Swap world for pi.',
      'agent: All done with tools.',
      'user: IMAGE what is this?[image/png]', '--', 'agent: That is a one-pixel image.',
      'user: ERROR trigger', '--',
      'user: ABORT this', '--', 'thought: Thinking slowly.', 'agent: Partial answer',
      '--', 'agent: Compaction completed.',
      'user: AFTER compaction', '--', 'thought: Brief.', 'agent: Continuing after compaction.',
      'user: MODEL switched', '--', 'agent: Now on the other model.',
      'user: STEER now', '--', 'agent: Sleeping.',
      'user (steered): NUDGE extra', 'agent: Got the steer.',
      '--', 'agent: Status: all good',
    ])
    const texts = events.flatMap((e) => (e.type === 'agent' && e.content[0].type === 'text' ? [e.content[0].text] : []))
    expect(texts.find((t) => t.startsWith('Compaction'))).toMatch(/^Compaction completed\.\nTokens before: 1020\n\n## Goal\n/)

    const calls = toolCalls(events)
    expect(calls.get('call_TOOLS_0_0')).toEqual({
      toolCallId: 'call_TOOLS_0_0', title: "printf 'one\\ntwo\\n'", kind: 'execute', shell: true,
      status: 'completed', output: 'one\ntwo\n',
    })
    expect(calls.get('call_TOOLS_1_0')).toMatchObject({
      title: 'read', kind: 'read', status: 'completed',
      locations: [{ path: '/workspace/hello.txt' }],
      content: [{ type: 'text', text: 'hello world\nsecond line\n' }],
    })
    expect(calls.get('call_TOOLS_2_0')).toMatchObject({
      title: 'write', kind: 'edit', status: 'completed',
      content: [{ type: 'diff', path: 'new.txt', newText: 'brand new\n' }],
    })
    expect(calls.get('call_TOOLS_3_0')).toMatchObject({
      title: 'edit', kind: 'edit', status: 'completed',
      locations: [{ path: '/workspace/hello.txt', line: 1 }],
      content: [{ type: 'diff', path: 'hello.txt', oldText: 'hello world\nsecond line\n', newText: 'hello pi\nsecond line\n' }],
    })
    expect(calls.get('call_TOOLS_4_0')).toMatchObject({ title: 'ls /nonexistent-dir', shell: true, status: 'failed' })
    expect(calls.get('call_TOOLS_4_0')?.output).toMatch(/No such file or directory\n\n\nCommand exited with code 2$/)
    expect(calls.get('call_TOOLS_5_0')).toMatchObject({
      title: 'grep', kind: 'other', locations: [{ path: '/workspace' }],
      content: [{ type: 'text', text: 'hello.txt:2: second line' }],
    })
    expect(calls.get('call_TOOLS_8_0')).toMatchObject({
      title: 'nosuch_tool', status: 'failed', content: [{ type: 'text', text: 'Tool nosuch_tool not found' }],
    })
    expect(calls.get('call_TOOLS_9_0')).toMatchObject({ title: 'edit', status: 'failed', content: [{ type: 'text' }] })
    expect([...calls.values()].at(-1)).toMatchObject({
      title: 'echo bang; exit 3', kind: 'execute', shell: true, status: 'failed', output: 'bang\n',
    })

    const image = events.find((e) => e.type === 'user' && e.content.length > 1)
    expect(image).toMatchObject({ content: [{ type: 'text' }, { type: 'image', mimeType: 'image/png' }] })
  })

  it('follows the active branch of a tree', () => {
    const lines = conversation(piTranscriptAsAcp(LINES.join('\n')))
    expect(lines.slice(-9)).toEqual([
      'user: AFTER compaction', '--', 'thought: Brief.', 'agent: Continuing after compaction.',
      '--', 'agent: **Branch Summary**',
      'user: On the branch now', '--', 'agent: Branch reply.',
    ])
    // Turns before the compaction are still shown; the abandoned path is not.
    expect(lines).toContain('user: TOOLS please')
    expect(lines).not.toContain('user: MODEL switched')
  })

  it('shows the images a tool returned, as the live projection does', () => {
    const message = (id: string, parentId: string | null, m: unknown): string =>
      JSON.stringify({ type: 'message', id, parentId, message: m })
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    const log = [
      message('u', null, { role: 'user', content: 'read it' }),
      message('a', 'u', { role: 'assistant', content: [{ type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'a.png' } }] }),
      message('t', 'a', {
        role: 'toolResult', toolCallId: 'r', toolName: 'read',
        content: [{ type: 'text', text: 'Read image file [image/png]' }, image],
      }),
    ].join('\n')

    expect(toolCalls(piTranscriptAsAcp(log)).get('r')?.content)
      .toEqual([{ type: 'text', text: 'Read image file [image/png]' }, image])
  })

  it('tolerates an empty, damaged or cyclic log', () => {
    expect(piTranscriptAsAcp('')).toEqual([])
    const cyclic = '{"type":"message","id":"a","parentId":"a","message":{"role":"user","content":"hi"}}'
    const events = piTranscriptAsAcp(`${LINEAR}\nnot json\n${cyclic}\n{"type":"mess`)
    expect(conversation(events)).toEqual(['user: hi', '--'])
  })

  it('keeps a hostile log from growing past the record cap or failing the read', () => {
    // A workspace writes this log. One large write, named by many results,
    // would show its content once per result; a deeply nested argument
    // cannot be serialized at all.
    const line = (o: unknown): string => JSON.stringify(o)
    const deep = `${'['.repeat(20_000)}"x"${']'.repeat(20_000)}`
    const message = (id: string, parentId: string | null, m: unknown): string => line({ type: 'message', id, parentId, message: m })
    const log = [
      line({ type: 'session', version: 3, id: 's', cwd: '/workspace' }),
      message('u', null, { role: 'user', content: 'write it' }),
      message('d', 'u', { role: 'assistant', content: [{ type: 'toolCall', id: 'deep', name: 'ls', arguments: { path: 'DEEP' } }] })
        .replace('"DEEP"', deep),
      message('a', 'd', { role: 'assistant', content: [
        { type: 'text', text: 'Writing.' },
        { type: 'toolCall', id: 'w', name: 'write', arguments: { path: 'big.txt', content: 'x'.repeat(2 * 1024 * 1024) } },
      ] }),
      ...Array.from({ length: 40 }, (_, i) =>
        message(`r${String(i)}`, i === 0 ? 'a' : `r${String(i - 1)}`, { role: 'toolResult', toolCallId: 'w', toolName: 'write', content: [] })),
    ].join('\n')

    const events = piTranscriptAsAcp(log)

    expect(conversation(events)).toEqual(['user: write it', '--', 'agent: Writing.'])
    // 40 results of 2 MB each would be 80 MB; the record stops near 64.
    const updates = events.filter((e) => e.type === 'tool' && e.call.toolCallId === 'w').length
    expect(updates).toBeGreaterThan(1)
    expect(updates).toBeLessThan(40)
  })
})
