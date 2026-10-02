import { describe, it, expect } from 'vitest'
import { mergeEvents } from '#lib/acp'
import { groupEvents } from '#components/AcpTranscript'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * De-duplicating a reconnect's replay, and grouping streamed chunks into
 * messages.
 */

const agent = (seq: number, text: string): AcpEvent =>
  ({ type: 'agent', seq, content: [{ type: 'text', text }] })
const user = (seq: number, text: string): AcpEvent =>
  ({ type: 'user', seq, content: [{ type: 'text', text }] })
const tool = (seq: number, id: string, status: 'pending' | 'completed', title = 'Read a.ts'): AcpEvent =>
  ({ type: 'tool', seq, call: { toolCallId: id, title, kind: 'read', status } })
const ask = (seq: number, requestId = '5'): AcpEvent => ({
  type: 'permission-request',
  seq,
  requestId,
  toolCall: { toolCallId: 'c1', title: 'rm -rf build', kind: 'execute', status: 'pending' },
  options: [
    { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    { optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
  ],
})
const resolved = (seq: number, optionId: string, requestId = '5'): AcpEvent =>
  ({ type: 'permission-resolved', seq, requestId, outcome: 'selected', optionId })

describe('mergeEvents', () => {
  it('appends new events in sequence order', () => {
    const merged = mergeEvents([agent(0, 'a')], [agent(1, 'b'), agent(2, 'c')])
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('de-duplicates a reconnect replay instead of doubling the conversation', () => {
    // A reattach replays the whole log, which must merge, not duplicate.
    const held = [user(0, 'hi'), agent(1, 'hello')]
    const replayed = [user(0, 'hi'), agent(1, 'hello'), agent(2, 'more')]
    const merged = mergeEvents(held, replayed)
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('orders out-of-order arrivals by seq, not by arrival', () => {
    const merged = mergeEvents([agent(5, 'e')], [agent(1, 'a'), agent(3, 'c')])
    expect(merged.map((e) => e.seq)).toEqual([1, 3, 5])
  })

  it('lets a replayed event supersede the one already held', () => {
    // Same seq, newer payload: the server is authoritative.
    const merged = mergeEvents([tool(0, 't1', 'pending')], [tool(0, 't1', 'completed')])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ call: { status: 'completed' } })
  })

  it('is a no-op for an empty batch', () => {
    const held = [agent(0, 'a')]
    expect(mergeEvents(held, [])).toBe(held)
  })
})

describe('groupEvents', () => {
  it('coalesces consecutive chunks of one kind into a single message', () => {
    // Streamed chunks form one message, not one bubble each.
    const groups = groupEvents([agent(0, 'Hello, '), agent(1, 'world'), agent(2, '!')])
    expect(groups).toEqual([{ kind: 'agent', seq: 0, text: 'Hello, world!', images: [] }])
  })

  it('starts a new message at a run the agent began itself', () => {
    // No user message precedes it, so without the boundary the two replies
    // would read as one ("startedfinished").
    const groups = groupEvents([agent(0, 'started'), { type: 'agent-turn', seq: 1 }, agent(2, 'finished')])
    expect(groups.map((g) => g.kind === 'agent' && g.text)).toEqual(['started', 'finished'])
  })

  it('keeps a user turn separate from the reply it precedes', () => {
    const groups = groupEvents([user(0, 'do it'), agent(1, 'ok'), agent(2, '!')])
    expect(groups).toEqual([
      { kind: 'user', seq: 0, text: 'do it', images: [] },
      { kind: 'agent', seq: 1, text: 'ok!', images: [] },
    ])
  })

  it('collapses a tool call onto its latest state, in the position it first appeared', () => {
    const groups = groupEvents([
      agent(0, 'looking'),
      tool(1, 't1', 'pending'),
      agent(2, ' and reading'),
      tool(3, 't1', 'completed'),
    ])
    // Two updates to one call are one row, which stays in its first position.
    expect(groups.map((g) => g.kind)).toEqual(['agent', 'tool', 'agent'])
    expect(groups[1]).toMatchObject({ seq: 1, call: { toolCallId: 't1', status: 'completed' } })
  })

  it('tracks two concurrent tool calls independently', () => {
    const groups = groupEvents([
      tool(0, 't1', 'pending', 'Read a.ts'),
      tool(1, 't2', 'pending', 'Read b.ts'),
      tool(2, 't1', 'completed', 'Read a.ts'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ call: { toolCallId: 't1', status: 'completed' } })
    expect(groups[1]).toMatchObject({ call: { toolCallId: 't2', status: 'pending' } })
  })

  it('marks a call its turn ended without finishing as interrupted', () => {
    // A Stop kills a running command, and the adapter never reports it done.
    const groups = groupEvents([
      tool(0, 't1', 'completed', 'ls'),
      tool(1, 't2', 'pending', 'sleep 50'),
      { type: 'turn-end', seq: 2, stopReason: 'cancelled' },
    ])
    expect(groups[0]).not.toHaveProperty('interrupted')
    expect(groups[1]).toMatchObject({ call: { toolCallId: 't2' }, interrupted: true })
  })

  it('ends an earlier turn at the next user message, since a replay has no turn ends', () => {
    const groups = groupEvents([user(0, 'one'), tool(1, 't1', 'pending'), user(2, 'two'), tool(3, 't2', 'pending')])
    expect(groups[1]).toMatchObject({ interrupted: true })
    expect(groups[3]).not.toHaveProperty('interrupted')
  })

  it('hides a normal turn end and surfaces an abnormal one', () => {
    // Only unusual stop reasons (a refusal, a token cap) get a divider.
    expect(groupEvents([agent(0, 'done'), { type: 'turn-end', seq: 1, stopReason: 'end_turn' }]))
      .toEqual([{ kind: 'agent', seq: 0, text: 'done', images: [] }])
    const capped = groupEvents([{ type: 'turn-end', seq: 0, stopReason: 'max_tokens' }])
    expect(capped).toEqual([{ kind: 'turn-end', seq: 0, stopReason: 'max_tokens' }])
  })

  it('drops the command list, which is menu data rather than conversation', () => {
    expect(groupEvents([
      { type: 'commands', seq: 0, commands: [{ name: 'clear' }] },
      agent(1, 'hi'),
    ])).toEqual([{ kind: 'agent', seq: 1, text: 'hi', images: [] }])
  })

  it('drops a turn start, which drives the indicator rather than the transcript', () => {
    // A turn start renders nothing.
    expect(groupEvents([{ type: 'turn-start', seq: 0 }, agent(1, 'hi')]))
      .toEqual([{ kind: 'agent', seq: 1, text: 'hi', images: [] }])
  })

  it('keeps a message\'s images apart from its words, across the chunks it came in', () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'AA==' }
    const groups = groupEvents([
      { type: 'user', seq: 0, content: [{ type: 'text', text: 'what is this?' }, image] },
      { type: 'agent', seq: 1, content: [image] },
      agent(2, 'a red square'),
    ])
    expect(groups).toEqual([
      { kind: 'user', seq: 0, text: 'what is this?', images: [image] },
      { kind: 'agent', seq: 1, text: 'a red square', images: [image] },
    ])
  })

  it('keeps thoughts out of the reply they interleave with', () => {
    const groups = groupEvents([agent(0, 'a'), { type: 'thought', seq: 1, content: [{ type: 'text', text: 'hmm' }] }, agent(2, 'b')])
    expect(groups.map((g) => g.kind)).toEqual(['agent', 'thought', 'agent'])
  })

  it('leaves an unanswered permission ask pending, in the place it was asked', () => {
    const groups = groupEvents([agent(0, 'let me clean up'), ask(1)])
    expect(groups.map((g) => g.kind)).toEqual(['agent', 'permission'])
    expect(groups[1]).toMatchObject({ requestId: '5' })
    // An undecided ask renders as a live question.
    expect(groups[1].kind === 'permission' && groups[1].decided).toBeUndefined()
  })

  it('settles the ask in place rather than appending its answer under it', () => {
    // The resolution updates the ask's row rather than adding another.
    const groups = groupEvents([ask(0), resolved(1, 'allow')])
    expect(groups.map((g) => g.kind)).toEqual(['permission'])
    expect(groups[0]).toMatchObject({
      seq: 0,
      requestId: '5',
      decided: { outcome: 'selected', optionId: 'allow' },
    })
  })

  it('keeps two open asks apart, settling only the one that was answered', () => {
    const groups = groupEvents([ask(0, '5'), ask(1, '6'), resolved(2, 'allow', '6')])
    expect(groups.map((g) => (g.kind === 'permission' ? g.decided?.optionId : null)))
      .toEqual([undefined, 'allow'])
  })

  it('drops an answer whose question is not in this stream', () => {
    // A resolution without its ask (a truncated record) renders nothing.
    expect(groupEvents([resolved(0, 'allow')])).toEqual([])
  })
})
