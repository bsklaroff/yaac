import { describe, it, expect } from 'vitest'
import { acpPaneTargets, defaultPaneTarget, paneStillLive } from '#lib/panes'
import { PREVIEW_TARGET } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/changesApi'
import type { AgentSessionEntry, WorkspaceListEntry } from '@yaac/shared/types'

/**
 * Which panes a workspace has. Chat panes stay mounted while hidden, so
 * `paneStillLive` is what unmounts an ended conversation's pane; otherwise
 * it would keep retrying a socket the server refuses.
 */

function session(over: Partial<AgentSessionEntry> = {}): AgentSessionEntry {
  return { agentSessionId: 'c1', tool: 'claude', mode: 'acp', ordinal: 0, active: true, ...over }
}

function workspace(sessions: AgentSessionEntry[]): WorkspaceListEntry {
  return {
    workspaceId: 'w1',
    projectSlug: 'proj',
    tool: 'claude',
    status: 'running',
    createdAt: '2026-01-01 00:00:00',
    blockedHosts: [],
    forwardedPorts: [],
    unforwardedPorts: [],
    agentSessions: sessions,
  }
}

/** A `tui` workspace: one agent, no conversation of its own. */
const tui = workspace([session({ mode: 'tui' })])
/** An `acp` workspace mid-conversation. */
const acp = workspace([session({ agentSessionId: 'conv-a' })])
/** An ACP workspace whose agent hasn't answered `session/new` yet. */
const booting = workspace([])

describe('acpPaneTargets', () => {
  it('names the live conversations and nothing else', () => {
    const mixed = workspace([
      session({ agentSessionId: 'conv-a' }),
      // Ended: no agent is behind it now.
      session({ agentSessionId: 'conv-b', active: false, ordinal: 1 }),
      // A TUI agent is a terminal, not a chat pane.
      session({ agentSessionId: 'conv-c', mode: 'tui', ordinal: 2 }),
      session({ agentSessionId: 'conv-d', mode: undefined, ordinal: 3 }),
    ])
    expect(acpPaneTargets(mixed)).toEqual(['acp:conv-a'])
    expect(acpPaneTargets(tui)).toEqual([])
    expect(acpPaneTargets(undefined)).toEqual([])
  })
})

describe('defaultPaneTarget', () => {
  it('opens the chat pane of an acp workspace and the terminal of a tui one', () => {
    // The warm-up attaches this pane, so an ACP workspace must answer its
    // chat pane, not acpd's `agent` window.
    expect(defaultPaneTarget(acp)).toBe('acp:conv-a')
    expect(defaultPaneTarget(tui)).toBe('agent')
  })

  it('falls back to the terminal while an acp workspace has no conversation yet', () => {
    expect(defaultPaneTarget(booting)).toBe('agent')
    expect(defaultPaneTarget(undefined)).toBe('agent')
  })

  it('opens the first conversation when a workspace has several', () => {
    const many = workspace([
      session({ agentSessionId: 'conv-a' }),
      session({ agentSessionId: 'conv-b', ordinal: 1 }),
    ])
    expect(defaultPaneTarget(many)).toBe('acp:conv-a')
  })
})

describe('paneStillLive', () => {
  it('drops a conversation that has ended, and keeps the ones that have not', () => {
    expect(paneStillLive(acp, 'acp:conv-a')).toBe(true)
    // An ended conversation's pane is no longer live.
    expect(paneStillLive(workspace([session({ agentSessionId: 'conv-a', active: false })]),
      'acp:conv-a')).toBe(false)
    // Nor is an unknown conversation's.
    expect(paneStillLive(acp, 'acp:conv-z')).toBe(false)
  })

  it('drops the raw agent pane of an acp workspace, whose window is acpd log', () => {
    // The warm-up may open `agent` while booting; once a conversation
    // appears, that pane must go.
    expect(paneStillLive(booting, 'agent')).toBe(true)
    expect(paneStillLive(acp, 'agent')).toBe(false)
    expect(paneStillLive(tui, 'agent')).toBe(true)
  })

  it('leaves every pane it does not own alone', () => {
    // Other panes are managed elsewhere and always count as live here.
    for (const wt of [acp, tui, booting]) {
      expect(paneStillLive(wt, '%12')).toBe(true)
      expect(paneStillLive(wt, PREVIEW_TARGET)).toBe(true)
      expect(paneStillLive(wt, CHANGES_TARGET)).toBe(true)
    }
  })
})
