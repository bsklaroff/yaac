// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sidebarRowIds, sidebarSections } from '#components/Sidebar'
import type { SessionListEntry } from '@yaac/shared/types'

const session = (sessionId: string, status: 'waiting' | 'running'): { sessionId: string; status: 'waiting' | 'running' } =>
  ({ sessionId, status })

/** A full SessionListEntry — sidebarSections keeps the whole row, not just id. */
const entry = (
  sessionId: string,
  status: 'waiting' | 'running',
  extra: Partial<SessionListEntry> = {},
): SessionListEntry => ({
  sessionId, projectSlug: 'p', tool: 'claude', status, createdAt: '2026-01-01 00:00:00',
  blockedHosts: [], forwardedPorts: [], ...extra,
})

const labels = (sessions: SessionListEntry[], pending: string[] = []): Record<string, string[]> =>
  Object.fromEntries(sidebarSections(sessions, pending).map((s) => [s.label, s.sessions.map((x) => x.sessionId)]))

describe('sidebarRowIds', () => {
  it('orders rows provisioning-first, then waiting, then running', () => {
    const rows = sidebarRowIds(
      [{ sessionId: 'prov-1' }],
      [session('run-1', 'running'), session('wait-1', 'waiting'), session('run-2', 'running')],
      [],
    )
    expect(rows).toEqual(['prov-1', 'wait-1', 'run-1', 'run-2'])
  })

  it('excludes optimistically-deleting sessions (pendingDeleteIds)', () => {
    const rows = sidebarRowIds(
      [],
      [session('a', 'waiting'), session('b', 'running')],
      ['a'],
    )
    expect(rows).toEqual(['b'])
  })

  it('excludes server-marked terminating rows (they render but are not selectable)', () => {
    const rows = sidebarRowIds(
      [],
      [{ sessionId: 'a', status: 'running', terminating: true }, session('b', 'running')],
      [],
    )
    expect(rows).toEqual(['b'])
  })

  it('returns an empty list with nothing to show', () => {
    expect(sidebarRowIds([], [], [])).toEqual([])
  })
})

describe('sidebarSections', () => {
  it('groups live sessions by status, in Waiting/Running/Terminating order', () => {
    const secs = sidebarSections(
      [entry('run-1', 'running'), entry('wait-1', 'waiting')],
      [],
    )
    expect(secs.map((s) => s.label)).toEqual(['Waiting', 'Running', 'Terminating'])
    expect(labels([entry('run-1', 'running'), entry('wait-1', 'waiting')])).toEqual({
      Waiting: ['wait-1'], Running: ['run-1'], Terminating: [],
    })
  })

  it('routes server-marked terminating sessions into the Terminating section', () => {
    // Terminating carries status:'running' on the wire, yet must not appear
    // under Running.
    expect(labels([entry('a', 'running', { terminating: true }), entry('b', 'running')])).toEqual({
      Waiting: [], Running: ['b'], Terminating: ['a'],
    })
  })

  it('routes optimistically-deleting sessions (pendingDeleteIds) into Terminating', () => {
    // A waiting session mid-delete leaves Waiting for Terminating.
    expect(labels([entry('a', 'waiting'), entry('b', 'running')], ['a'])).toEqual({
      Waiting: [], Running: ['b'], Terminating: ['a'],
    })
  })
})
