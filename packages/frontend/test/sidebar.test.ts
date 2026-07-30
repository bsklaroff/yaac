// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sidebarRowIds, sidebarSections } from '#components/Sidebar'
import type { DeletedSessionEntry, SessionListEntry } from '@yaac/shared/types'

const session = (
  sessionId: string,
  status: 'waiting' | 'running',
  extra: Partial<SessionListEntry> = {},
): Pick<SessionListEntry, 'sessionId' | 'status' | 'terminating' | 'background'> =>
  ({ sessionId, status, ...extra })

/** A full SessionListEntry — sidebarSections keeps the whole row, not just id. */
const entry = (
  sessionId: string,
  status: 'waiting' | 'running',
  extra: Partial<SessionListEntry> = {},
): SessionListEntry => ({
  sessionId, projectSlug: 'p', tool: 'claude', status, createdAt: '2026-01-01 00:00:00',
  blockedHosts: [], forwardedPorts: [], unforwardedPorts: [], ...extra,
})

const deletedEntry = (sessionId: string): DeletedSessionEntry => ({
  sessionId, projectSlug: 'p', tool: 'claude', createdAt: '2026-01-01 00:00:00',
  seen: false, background: true,
})

const labels = (
  sessions: SessionListEntry[],
  pending: string[] = [],
  deleted: DeletedSessionEntry[] = [],
): Record<string, string[]> =>
  Object.fromEntries(sidebarSections(sessions, pending, deleted).map((s) => [s.label, s.sessions.map((x) => x.sessionId)]))

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
      [session('a', 'running', { terminating: true }), session('b', 'running')],
      [],
    )
    expect(rows).toEqual(['b'])
  })

  it('places background rows after the status groups, whatever their status', () => {
    const rows = sidebarRowIds(
      [],
      [
        session('bg-wait', 'waiting', { background: true }),
        session('run-1', 'running'),
        session('wait-1', 'waiting'),
        session('bg-run', 'running', { background: true }),
      ],
      [],
    )
    expect(rows).toEqual(['wait-1', 'run-1', 'bg-wait', 'bg-run'])
  })

  it('excludes terminating background rows like any other terminating row', () => {
    const rows = sidebarRowIds(
      [],
      [session('a', 'running', { background: true, terminating: true }), session('b', 'running', { background: true })],
      [],
    )
    expect(rows).toEqual(['b'])
  })

  it('returns an empty list with nothing to show', () => {
    expect(sidebarRowIds([], [], [])).toEqual([])
  })
})

describe('sidebarSections', () => {
  it('groups live sessions by status, in Waiting/Running/Background/Terminating order', () => {
    const secs = sidebarSections(
      [entry('run-1', 'running'), entry('wait-1', 'waiting')],
      [],
    )
    expect(secs.map((s) => s.label)).toEqual(['Waiting', 'Running', 'Background', 'Terminating'])
    expect(labels([entry('run-1', 'running'), entry('wait-1', 'waiting')])).toEqual({
      Waiting: ['wait-1'], Running: ['run-1'], Background: [], Terminating: [],
    })
  })

  it('routes server-marked terminating sessions into the Terminating section', () => {
    // Terminating carries status:'running' on the wire, yet must not appear
    // under Running.
    expect(labels([entry('a', 'running', { terminating: true }), entry('b', 'running')])).toEqual({
      Waiting: [], Running: ['b'], Background: [], Terminating: ['a'],
    })
  })

  it('routes optimistically-deleting sessions (pendingDeleteIds) into Terminating', () => {
    // A waiting session mid-delete leaves Waiting for Terminating.
    expect(labels([entry('a', 'waiting'), entry('b', 'running')], ['a'])).toEqual({
      Waiting: [], Running: ['b'], Background: [], Terminating: ['a'],
    })
  })

  it('routes background sessions into Background whatever their status', () => {
    expect(labels([
      entry('bg-wait', 'waiting', { background: true }),
      entry('bg-run', 'running', { background: true }),
      entry('wait-1', 'waiting'),
    ])).toEqual({
      Waiting: ['wait-1'], Running: [], Background: ['bg-wait', 'bg-run'], Terminating: [],
    })
  })

  it('keeps a terminating background session in Background, not Terminating', () => {
    expect(labels([
      entry('bg-term', 'running', { background: true, terminating: true }),
      entry('term', 'running', { terminating: true }),
    ])).toEqual({
      Waiting: [], Running: [], Background: ['bg-term'], Terminating: ['term'],
    })
  })

  it('carries deleted background rows on the Background section', () => {
    const secs = sidebarSections(
      [entry('bg-run', 'running', { background: true })],
      [],
      [deletedEntry('bg-gone')],
    )
    const background = secs.find((s) => s.label === 'Background')
    expect(background?.sessions.map((s) => s.sessionId)).toEqual(['bg-run'])
    expect(background?.deleted?.map((d) => d.sessionId)).toEqual(['bg-gone'])
    // The other sections carry no deleted rows.
    expect(secs.filter((s) => s.label !== 'Background').every((s) => !s.deleted?.length)).toBe(true)
  })
})
