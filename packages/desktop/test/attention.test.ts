import { describe, it, expect } from 'vitest'
import {
  selectWaiting,
  waitingKey,
  diffNewlyWaiting,
  badgeText,
  notificationFor,
  parseSnapshotMessage,
  AttentionMonitor,
} from '#attention'
import type { ServerSnapshot, SessionListEntry } from '@yaac/shared/types'

const snap = (sessions: Array<Partial<SessionListEntry>>): ServerSnapshot => ({
  sessions: sessions.map((s, i): SessionListEntry => ({
    sessionId: s.sessionId ?? `s${i}`,
    projectSlug: s.projectSlug ?? 'proj',
    tool: s.tool ?? 'claude',
    status: s.status ?? 'running',
    createdAt: '2026-01-01 00:00:00',
    blockedHosts: [],
    forwardedPorts: [],
    unforwardedPorts: [],
    ...s,
  })),
  stale: [],
  projects: [],
  provisioning: [],
  gitAuthFailures: {},
  imageBuilds: [],
  planUsage: null,
  forwardBindHost: '127.0.0.1',
  codexPlanUsage: null,
})

describe('selectWaiting', () => {
  it('keeps only waiting sessions', () => {
    const out = selectWaiting(snap([
      { sessionId: 'a', status: 'waiting' },
      { sessionId: 'b', status: 'running' },
    ]))
    expect(out.map((s) => s.sessionId)).toEqual(['a'])
  })
  it('falls back title → prompt → id', () => {
    const out = selectWaiting(snap([
      { sessionId: 'a', status: 'waiting', title: 'T' },
      { sessionId: 'b', status: 'waiting', prompt: 'P' },
      { sessionId: 'c', status: 'waiting' },
    ]))
    expect(out.map((s) => s.title)).toEqual(['T', 'P', 'c'])
  })
})

describe('waitingKey', () => {
  it('encodes the session and the waiting spell', () => {
    expect(waitingKey({ sessionId: 'a', projectSlug: 'p', tool: 'claude', title: 't', waitingSinceMs: 5 }))
      .toBe('a#5')
  })
  it('is stable when there is no stamp', () => {
    expect(waitingKey({ sessionId: 'a', projectSlug: 'p', tool: 'claude', title: 't' })).toBe('a#')
  })
})

describe('diffNewlyWaiting', () => {
  const w = (id: string, since?: number): ReturnType<typeof selectWaiting>[number] =>
    ({ sessionId: id, projectSlug: 'p', tool: 'claude', title: id, waitingSinceMs: since })

  it('reports sessions absent from prevKeys as newly waiting', () => {
    const { toNotify, nextKeys } = diffNewlyWaiting(new Set(['a#1']), [w('a', 1), w('b', 2)])
    expect(toNotify.map((s) => s.sessionId)).toEqual(['b'])
    expect([...nextKeys].sort()).toEqual(['a#1', 'b#2'])
  })
  it('re-notifies a new spell of the same session', () => {
    const { toNotify } = diffNewlyWaiting(new Set(['a#1']), [w('a', 2)])
    expect(toNotify.map((s) => s.sessionId)).toEqual(['a'])
  })
})

describe('badgeText', () => {
  it('is the count when positive', () => expect(badgeText(3)).toBe('3'))
  it('is empty at zero', () => expect(badgeText(0)).toBe(''))
})

describe('notificationFor', () => {
  it('names the project and session', () => {
    expect(notificationFor({ sessionId: 'a', projectSlug: 'proj', tool: 'claude', title: 'Fix bug' }))
      .toEqual({ title: 'Session waiting for you', body: 'proj · Fix bug' })
  })
})

describe('parseSnapshotMessage', () => {
  it('returns the data of a snapshot frame', () => {
    const s = snap([{ sessionId: 'a', status: 'waiting' }])
    expect(parseSnapshotMessage(JSON.stringify({ type: 'snapshot', data: s }))?.sessions).toHaveLength(1)
  })
  it('returns null for a non-snapshot frame', () => {
    expect(parseSnapshotMessage(JSON.stringify({ type: 'other', data: {} }))).toBeNull()
  })
  it('returns null for malformed json', () => {
    expect(parseSnapshotMessage('{not json')).toBeNull()
  })
})

describe('AttentionMonitor', () => {
  it('seeds silently on the first snapshot but still counts', () => {
    const m = new AttentionMonitor()
    const r = m.update(snap([{ sessionId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.waitingCount).toBe(1)
    expect(r.toNotify).toEqual([])
  })
  it('notifies on a session that enters waiting after seeding', () => {
    const m = new AttentionMonitor()
    m.update(snap([{ sessionId: 'a', status: 'running' }]))
    const r = m.update(snap([{ sessionId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.toNotify.map((s) => s.sessionId)).toEqual(['a'])
    expect(r.waitingCount).toBe(1)
  })
  it('does not re-notify an ongoing wait', () => {
    const m = new AttentionMonitor()
    m.update(snap([{ sessionId: 'a', status: 'running' }]))
    m.update(snap([{ sessionId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    const r = m.update(snap([{ sessionId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.toNotify).toEqual([])
    expect(r.waitingCount).toBe(1)
  })
})
