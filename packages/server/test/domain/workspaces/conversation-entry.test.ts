import { describe, it, expect } from 'vitest'
import { toConversationEntry } from '#domain/workspaces/conversation-entry'
import type { ConversationLinkRow, SessionRow } from '#db'

function link(over: Partial<ConversationLinkRow> = {}): ConversationLinkRow {
  return {
    projectId: 'proj',
    workspaceId: 'wt1',
    conversationId: 'sid-1',
    tool: 'claude',
    mode: 'tui',
    ordinal: 0,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }
}

describe('toConversationEntry', () => {
  it('renders a conversation with its session and opening message', () => {
    const entry = toConversationEntry(
      link({
        firstPrompt: 'fix the thing',
        sessionId: 'sess-1',
        lastActiveAt: new Date('2026-03-04T05:06:07.891Z'),
      }),
    )
    expect(entry).toEqual({
      conversationId: 'sid-1',
      tool: 'claude',
      mode: 'tui',
      ordinal: 0,
      active: true,
      sessionId: 'sess-1',
      prompt: 'fix the thing',
      // Every surface shows this format. Both forms are strings, so tsc
      // would not catch a mismatch.
      lastActiveAt: '2026-03-04 05:06:07',
    })
  })

  // The catalog's display name goes out beside the model id when there is
  // one, matching how the create form names it.
  it('names the model from the catalog, and sends the bare id where it has none', () => {
    expect(toConversationEntry(link({ model: 'claude-opus-5-5' })))
      .toMatchObject({ model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    // A dated snapshot id resolves through its alias.
    expect(toConversationEntry(link({ model: 'claude-sonnet-4-5-20250929' })).modelName)
      .toBe('Sonnet 4.5')
    const typed = toConversationEntry(link({ model: 'claude-next' }))
    expect(typed.model).toBe('claude-next')
    expect('modelName' in typed).toBe(false)
  })

  // A stopped tab keeps its agent's name, but only for the conversation the
  // agent held last: one it left with `/clear` keeps the tool's own title.
  it('takes its agent\'s title for the conversation that agent held last, else the tool\'s', () => {
    const agent = { id: 'sess-1', conversationId: 'sid-2', title: 'Parser fix' } as SessionRow
    const last = link({ conversationId: 'sid-2', sessionId: 'sess-1', title: 'Fix the parser' })
    const cleared = link({ conversationId: 'sid-1', sessionId: 'sess-1', title: 'Tidy the docs' })
    expect(toConversationEntry(last, [agent]).title).toBe('Parser fix')
    expect(toConversationEntry(cleared, [agent]).title).toBe('Tidy the docs')
    expect(toConversationEntry(last, [{ ...agent, title: undefined }]).title).toBe('Fix the parser')
    expect(toConversationEntry(last).title).toBe('Fix the parser')
  })

  it('omits what a conversation has not recorded', () => {
    const entry = toConversationEntry(link({ active: false, ordinal: 2 }))
    expect(entry).toEqual({
      conversationId: 'sid-1',
      tool: 'claude',
      mode: 'tui',
      ordinal: 2,
      active: false,
    })
    // Keys are absent, not undefined.
    expect('sessionId' in entry).toBe(false)
    expect('lastActiveAt' in entry).toBe(false)
    expect('prompt' in entry).toBe(false)
    expect('title' in entry).toBe(false)
  })
})
