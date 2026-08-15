import { describe, it, expect } from 'vitest'
import { acpPaneTargets, defaultPaneTarget, paneStillLive } from '#lib/panes'
import { PREVIEW_TARGET } from '#lib/preview'
import { CHANGES_TARGET } from '#lib/changesApi'
import type { AgentSessionEntry, WorktreeListEntry } from '@yaac/shared/types'

/**
 * Which panes a worktree has. This is what decides whether a kept-alive pane
 * is holding a live connection or an invisible retry loop: a chat pane stays
 * mounted when it goes off-screen, so nothing else ever takes one down, and
 * the answers here are the only thing standing between an ended conversation
 * and a socket the server refuses for the rest of the worktree's life.
 */

function session(over: Partial<AgentSessionEntry> = {}): AgentSessionEntry {
  return { agentSessionId: 'c1', tool: 'claude', mode: 'acp', ordinal: 0, active: true, ...over }
}

function worktree(sessions: AgentSessionEntry[]): WorktreeListEntry {
  return {
    worktreeId: 'w1',
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

/** A `tui` worktree: one agent, no conversation of its own. */
const tui = worktree([session({ mode: 'tui' })])
/** An `acp` worktree mid-conversation. */
const acp = worktree([session({ agentSessionId: 'conv-a' })])
/** The seconds after an ACP worktree is created, before its agent has
 *  answered `session/new` — in the snapshot with nothing to show yet. */
const booting = worktree([])

describe('acpPaneTargets', () => {
  it('names the live conversations and nothing else', () => {
    const mixed = worktree([
      session({ agentSessionId: 'conv-a' }),
      // Ended: restorable on a restart, but there is no agent behind it now.
      session({ agentSessionId: 'conv-b', active: false, ordinal: 1 }),
      // A TUI agent is a terminal, not a chat pane — and a row recorded
      // before modes existed carries no `mode` at all and is likewise `tui`.
      session({ agentSessionId: 'conv-c', mode: 'tui', ordinal: 2 }),
      session({ agentSessionId: 'conv-d', mode: undefined, ordinal: 3 }),
    ])
    expect(acpPaneTargets(mixed)).toEqual(['acp:conv-a'])
    expect(acpPaneTargets(tui)).toEqual([])
    expect(acpPaneTargets(undefined)).toEqual([])
  })
})

describe('defaultPaneTarget', () => {
  it('opens the chat pane of an acp worktree and the terminal of a tui one', () => {
    // This is also what the eager warm-up pre-attaches, so answering `agent`
    // for an ACP worktree would warm a PTY onto acpd's log and leave the
    // conversation — the thing a click actually reveals — cold.
    expect(defaultPaneTarget(acp)).toBe('acp:conv-a')
    expect(defaultPaneTarget(tui)).toBe('agent')
  })

  it('falls back to the terminal while an acp worktree has no conversation yet', () => {
    expect(defaultPaneTarget(booting)).toBe('agent')
    expect(defaultPaneTarget(undefined)).toBe('agent')
  })

  it('opens the first conversation when a worktree has several', () => {
    const many = worktree([
      session({ agentSessionId: 'conv-a' }),
      session({ agentSessionId: 'conv-b', ordinal: 1 }),
    ])
    expect(defaultPaneTarget(many)).toBe('acp:conv-a')
  })
})

describe('paneStillLive', () => {
  it('drops a conversation that has ended, and keeps the ones that have not', () => {
    expect(paneStillLive(acp, 'acp:conv-a')).toBe(true)
    // The pane is kept mounted while hidden, so this answer is the only thing
    // that unmounts it — otherwise it retries a refused socket forever.
    expect(paneStillLive(worktree([session({ agentSessionId: 'conv-a', active: false })]),
      'acp:conv-a')).toBe(false)
    // Same for a conversation the worktree has simply never heard of.
    expect(paneStillLive(acp, 'acp:conv-z')).toBe(false)
  })

  it('drops the raw agent pane of an acp worktree, whose window is acpd log', () => {
    // The warm-up opens one during the booting window above; once a
    // conversation appears, that hidden PTY has to go with it.
    expect(paneStillLive(booting, 'agent')).toBe(true)
    expect(paneStillLive(acp, 'agent')).toBe(false)
    expect(paneStillLive(tui, 'agent')).toBe(true)
  })

  it('leaves every pane it does not own alone', () => {
    // A terminal window is the terminals poll's business, and preview/changes
    // are the user's — an ACP worktree's shells must not be swept up with its
    // agent pane.
    for (const wt of [acp, tui, booting]) {
      expect(paneStillLive(wt, '%12')).toBe(true)
      expect(paneStillLive(wt, PREVIEW_TARGET)).toBe(true)
      expect(paneStillLive(wt, CHANGES_TARGET)).toBe(true)
    }
  })
})
