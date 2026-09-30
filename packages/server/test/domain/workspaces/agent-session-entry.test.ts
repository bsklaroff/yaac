import { describe, it, expect } from 'vitest'
import { toAgentSessionEntry } from '#domain/workspaces/agent-session-entry'
import type { AgentSessionLinkRow } from '#db'

function link(over: Partial<AgentSessionLinkRow> = {}): AgentSessionLinkRow {
  return {
    projectSlug: 'proj',
    workspaceId: 'wt1',
    agentSessionId: 'sid-1',
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

describe('toAgentSessionEntry', () => {
  it('renders a live conversation with the observed status folded in', () => {
    const entry = toAgentSessionEntry(
      link({
        firstPrompt: 'fix the thing',
        lastActiveAt: new Date('2026-03-04T05:06:07.891Z'),
        paneId: '%3',
      }),
      { status: 'waiting', waitingSinceMs: 1_700_000_000_000 },
    )
    expect(entry).toEqual({
      agentSessionId: 'sid-1',
      tool: 'claude',
      mode: 'tui',
      ordinal: 0,
      active: true,
      status: 'waiting',
      waitingSinceMs: 1_700_000_000_000,
      prompt: 'fix the thing',
      // Every surface shows this format. Both forms are strings, so tsc
      // would not catch a mismatch.
      lastActiveAt: '2026-03-04 05:06:07',
    })
  })

  // The catalog's display name goes out beside the model id when there is
  // one, matching how the create form names it.
  it('names the model from the catalog, and sends the bare id where it has none', () => {
    expect(toAgentSessionEntry(link({ model: 'claude-opus-5-5' })))
      .toMatchObject({ model: 'claude-opus-5-5', modelName: 'Opus 5.5' })
    // A dated snapshot id resolves through its alias.
    expect(toAgentSessionEntry(link({ model: 'claude-sonnet-4-5-20250929' })).modelName)
      .toBe('Sonnet 4.5')
    const typed = toAgentSessionEntry(link({ model: 'claude-next' }))
    expect(typed.model).toBe('claude-next')
    expect('modelName' in typed).toBe(false)
  })

  it('omits the live half entirely for a conversation nothing is observing', () => {
    const entry = toAgentSessionEntry(link({ active: false, ordinal: 2 }))
    expect(entry).toEqual({
      agentSessionId: 'sid-1',
      tool: 'claude',
      mode: 'tui',
      ordinal: 2,
      active: false,
    })
    // Keys are absent, not undefined: that is how a client tells an open
    // conversation from a closed one.
    expect('status' in entry).toBe(false)
    expect('lastActiveAt' in entry).toBe(false)
    expect('prompt' in entry).toBe(false)
  })

  it('carries a running conversation that has no waiting spell', () => {
    const entry = toAgentSessionEntry(link({ mode: 'acp' }), { status: 'running' })
    expect(entry.status).toBe('running')
    expect(entry.mode).toBe('acp')
    expect('waitingSinceMs' in entry).toBe(false)
  })
})
