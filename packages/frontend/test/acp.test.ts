import { describe, it, expect } from 'vitest'
import { mergeEvents } from '#lib/acp'
import { groupEvents } from '#components/SessionChat'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * The two pure steps between the wire and the rendered pane: de-duplicating a
 * reconnect's replay, and folding a chunked stream into readable messages.
 * Both are where a chat pane silently doubles or loses content, and neither
 * needs a DOM to be wrong.
 */

const agent = (seq: number, text: string): AcpEvent =>
  ({ type: 'agent', seq, content: [{ type: 'text', text }] })
const user = (seq: number, text: string): AcpEvent =>
  ({ type: 'user', seq, content: [{ type: 'text', text }] })
const tool = (seq: number, id: string, status: 'pending' | 'completed', title = 'Read a.ts'): AcpEvent =>
  ({ type: 'tool', seq, call: { toolCallId: id, title, kind: 'read', status } })

describe('mergeEvents', () => {
  it('appends new events in sequence order', () => {
    const merged = mergeEvents([agent(0, 'a')], [agent(1, 'b'), agent(2, 'c')])
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('de-duplicates a reconnect replay instead of doubling the conversation', () => {
    // Attaching replays the whole log, so a pane that already holds part of it
    // must merge rather than append — the failure mode is every message
    // appearing twice after a dropped connection.
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
    // The agent streams token by token; each chunk is its own event, and
    // rendering one bubble per chunk is the thing this prevents.
    const groups = groupEvents([agent(0, 'Hello, '), agent(1, 'world'), agent(2, '!')])
    expect(groups).toEqual([{ kind: 'agent', seq: 0, text: 'Hello, world!' }])
  })

  it('keeps a user turn separate from the reply it precedes', () => {
    const groups = groupEvents([user(0, 'do it'), agent(1, 'ok'), agent(2, '!')])
    expect(groups).toEqual([
      { kind: 'user', seq: 0, text: 'do it' },
      { kind: 'agent', seq: 1, text: 'ok!' },
    ])
  })

  it('collapses a tool call onto its latest state, in the position it first appeared', () => {
    const groups = groupEvents([
      agent(0, 'looking'),
      tool(1, 't1', 'pending'),
      agent(2, ' and reading'),
      tool(3, 't1', 'completed'),
    ])
    // Two updates to one call are one row — and it stays where it started, so
    // the transcript does not reshuffle as the call finishes.
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

  it('hides a normal turn end and surfaces an abnormal one', () => {
    // A divider under every single reply is noise; a refusal or a token cap is
    // the user's business.
    expect(groupEvents([agent(0, 'done'), { type: 'turn-end', seq: 1, stopReason: 'end_turn' }]))
      .toEqual([{ kind: 'agent', seq: 0, text: 'done' }])
    const capped = groupEvents([{ type: 'turn-end', seq: 0, stopReason: 'max_tokens' }])
    expect(capped).toEqual([{ kind: 'turn-end', seq: 0, stopReason: 'max_tokens' }])
  })

  it('drops the command list, which is menu data rather than conversation', () => {
    expect(groupEvents([
      { type: 'commands', seq: 0, commands: [{ name: 'clear' }] },
      agent(1, 'hi'),
    ])).toEqual([{ kind: 'agent', seq: 1, text: 'hi' }])
  })

  it('renders an image chunk as a placeholder rather than dropping the message', () => {
    const groups = groupEvents([
      { type: 'agent', seq: 0, content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] },
    ])
    expect(groups).toEqual([{ kind: 'agent', seq: 0, text: '[image/png image]' }])
  })

  it('keeps thoughts out of the reply they interleave with', () => {
    const groups = groupEvents([agent(0, 'a'), { type: 'thought', seq: 1, content: [{ type: 'text', text: 'hmm' }] }, agent(2, 'b')])
    expect(groups.map((g) => g.kind)).toEqual(['agent', 'thought', 'agent'])
  })
})
