import { describe, it, expect } from 'vitest'
import { toAgentSessionEntry } from '#domain/worktrees/agent-session-entry'
import type { AgentSessionLinkRow } from '#db'

function link(over: Partial<AgentSessionLinkRow> = {}): AgentSessionLinkRow {
  return {
    projectSlug: 'proj',
    worktreeId: 'wt1',
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
      // The single format every surface shows — the reason one mapper serves
      // all three (both forms are `string`, so tsc cannot catch a drift).
      lastActiveAt: '2026-03-04 05:06:07',
    })
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
    // Absent rather than undefined: this is how a client tells a conversation
    // that is still open from one that merely was.
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
