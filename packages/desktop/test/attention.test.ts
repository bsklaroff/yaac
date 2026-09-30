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
import type { ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

const snap = (entries: Array<Partial<WorkspaceListEntry>>): ServerSnapshot => ({
  driver: 'k8s',
  workspaceGroups: [],
  queuedWorkspaces: [],
  heldWorkspaces: [],
  draftWorkspaces: [],
  workspaces: entries.map((s, i): WorkspaceListEntry => ({
    workspaceId: s.workspaceId ?? `s${i}`,
    projectSlug: s.projectSlug ?? 'proj',
    tool: s.tool ?? 'claude',
    status: s.status ?? 'running',
    createdAt: '2026-01-01 00:00:00',
    blockedHosts: [],
    forwardedPorts: [],
    unforwardedPorts: [],
    agentSessions: [],
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
  it('keeps only waiting workspaces', () => {
    const out = selectWaiting(snap([
      { workspaceId: 'a', status: 'waiting' },
      { workspaceId: 'b', status: 'running' },
    ]))
    expect(out.map((s) => s.workspaceId)).toEqual(['a'])
  })
  it('falls back title → prompt → id', () => {
    const out = selectWaiting(snap([
      { workspaceId: 'a', status: 'waiting', title: 'T' },
      { workspaceId: 'b', status: 'waiting', prompt: 'P' },
      { workspaceId: 'c', status: 'waiting' },
    ]))
    expect(out.map((s) => s.title)).toEqual(['T', 'P', 'c'])
  })
})

describe('waitingKey', () => {
  it('encodes the workspace and the waiting spell', () => {
    expect(waitingKey({ workspaceId: 'a', projectSlug: 'p', tool: 'claude', title: 't', waitingSinceMs: 5 }))
      .toBe('a#5')
  })
  it('is stable when there is no stamp', () => {
    expect(waitingKey({ workspaceId: 'a', projectSlug: 'p', tool: 'claude', title: 't' })).toBe('a#')
  })
})

describe('diffNewlyWaiting', () => {
  const w = (id: string, since?: number): ReturnType<typeof selectWaiting>[number] =>
    ({ workspaceId: id, projectSlug: 'p', tool: 'claude', title: id, waitingSinceMs: since })

  it('reports workspaces absent from prevKeys as newly waiting', () => {
    const { toNotify, nextKeys } = diffNewlyWaiting(new Set(['a#1']), [w('a', 1), w('b', 2)])
    expect(toNotify.map((s) => s.workspaceId)).toEqual(['b'])
    expect([...nextKeys].sort()).toEqual(['a#1', 'b#2'])
  })
  it('re-notifies a new spell of the same workspace', () => {
    const { toNotify } = diffNewlyWaiting(new Set(['a#1']), [w('a', 2)])
    expect(toNotify.map((s) => s.workspaceId)).toEqual(['a'])
  })
})

describe('badgeText', () => {
  it('is the count when positive', () => expect(badgeText(3)).toBe('3'))
  it('is empty at zero', () => expect(badgeText(0)).toBe(''))
})

describe('notificationFor', () => {
  it('names the project and workspace', () => {
    expect(notificationFor({ workspaceId: 'a', projectSlug: 'proj', tool: 'claude', title: 'Fix bug' }))
      .toEqual({ title: 'Workspace waiting for you', body: 'proj · Fix bug' })
  })
})

describe('parseSnapshotMessage', () => {
  it('returns the data of a snapshot frame', () => {
    const s = snap([{ workspaceId: 'a', status: 'waiting' }])
    expect(parseSnapshotMessage(JSON.stringify({ type: 'snapshot', data: s }))?.workspaces).toHaveLength(1)
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
    const r = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.waitingCount).toBe(1)
    expect(r.toNotify).toEqual([])
  })
  it('notifies on a workspace that enters waiting after seeding', () => {
    const m = new AttentionMonitor()
    m.update(snap([{ workspaceId: 'a', status: 'running' }]))
    const r = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.toNotify.map((s) => s.workspaceId)).toEqual(['a'])
    expect(r.waitingCount).toBe(1)
  })
  it('does not re-notify an ongoing wait', () => {
    const m = new AttentionMonitor()
    m.update(snap([{ workspaceId: 'a', status: 'running' }]))
    m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    const r = m.update(snap([{ workspaceId: 'a', status: 'waiting', waitingSinceMs: 1 }]))
    expect(r.toNotify).toEqual([])
    expect(r.waitingCount).toBe(1)
  })
})
