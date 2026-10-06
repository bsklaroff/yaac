import { describe, it, expect } from 'vitest'
import { acpPaneTargets, defaultPaneTarget, paneStillLive, syncPaneLayout } from '#lib/panes'
import { addColumn, addTab, paneTargets, singleColumn } from '#lib/layout'
import { PREVIEW_TARGET } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/panes'
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
    projectId: 'proj',
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

  it('keeps a terminal pane while its window is listed, and special panes always', () => {
    const shell = { target: 'window:@3', name: 'shell' }
    for (const wt of [acp, tui, booting]) {
      // Windows not listed yet: nothing is known to be gone.
      expect(paneStillLive(wt, 'window:@3')).toBe(true)
      expect(paneStillLive({ ...wt, terminals: [shell] }, 'window:@3')).toBe(true)
      expect(paneStillLive({ ...wt, terminals: [] }, 'window:@3')).toBe(false)
      expect(paneStillLive({ ...wt, terminals: [] }, PREVIEW_TARGET)).toBe(true)
      expect(paneStillLive({ ...wt, terminals: [] }, CHANGES_TARGET)).toBe(true)
    }
  })
})

describe('syncPaneLayout', () => {
  it('appends new windows, drops killed ones, and keeps special panes', () => {
    const layout = addColumn(addColumn(singleColumn('agent'), '%1'), PREVIEW_TARGET)
    const next = syncPaneLayout(layout, tui, ['%2'])
    expect(paneTargets(next)).toEqual(['agent', PREVIEW_TARGET, '%2'])
    // Already in line: the same reference, so nothing is stored.
    expect(syncPaneLayout(next, tui, ['%2'])).toBe(next)
  })

  it('puts the chat pane where the agent fallback was, left of panes opened beside it', () => {
    // A shell opened before the conversation (or before any layout was
    // stored) lands beside `agent`; the chat pane must take agent's column.
    const layout = addColumn(singleColumn('agent'), '%1')
    expect(paneTargets(syncPaneLayout(layout, acp, ['%1']))).toEqual(['acp:conv-a', '%1'])
    // Also as a tab: it takes agent's tab, active if agent was.
    const tabbed = addTab(singleColumn('%1'), 0, 'agent')
    expect(syncPaneLayout(tabbed, acp, ['%1'])).toEqual([{ tabs: ['%1', 'acp:conv-a'], active: 'acp:conv-a' }])
  })

  it('drops the agent pane once the chat pane is already shown, and ended conversations', () => {
    const layout = addColumn(addColumn(singleColumn('acp:conv-a'), 'agent'), 'acp:conv-old')
    expect(paneTargets(syncPaneLayout(layout, acp, []))).toEqual(['acp:conv-a'])
  })
})
