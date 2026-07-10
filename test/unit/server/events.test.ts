import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@yaac/server/lib/session/list', () => ({
  listActiveSessions: vi.fn().mockResolvedValue({ sessions: [], stale: [], gitAuthFailures: {} }),
}))

vi.mock('@yaac/server/lib/project/list', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
}))

// The real slice reads the credentials file and kicks upstream refreshes —
// keep unit-test snapshot builds inert.
vi.mock('@yaac/server/plan-usage', () => ({
  planUsageForSnapshot: vi.fn().mockResolvedValue(null),
}))

import { EventHub, buildSnapshot, serializeEvent } from '@yaac/server/events'
import type { WsLike } from '@yaac/server/events'
import { listActiveSessions } from '@yaac/server/lib/session/list'
import { registerProvisioning, removeProvisioning, clearAllProvisioningForTests } from '@yaac/server/provisioning'
import { registerImageBuild, clearAllImageBuildsForTests } from '@yaac/server/image-builds'
import type { ServerSnapshot } from '@yaac/shared/types'

function emptySnapshot(): ServerSnapshot {
  return {
    sessions: [], stale: [], projects: [], provisioning: [], gitAuthFailures: {}, imageBuilds: [],
    planUsage: null,
  }
}

function snapshotWithProject(slug: string): ServerSnapshot {
  return {
    ...emptySnapshot(),
    projects: [{ slug, remoteUrl: 'https://example.com/r.git', addedAt: '2026-01-01', sessionCount: 0 }],
  }
}

class FakeWs implements WsLike {
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

class ThrowingWs implements WsLike {
  send(): void {
    throw new Error('socket closed')
  }
}

describe('serializeEvent', () => {
  it('serializes a snapshot event to JSON', () => {
    const parsed = JSON.parse(serializeEvent({ type: 'snapshot', data: emptySnapshot() })) as {
      type: string
      data: ServerSnapshot
    }
    expect(parsed.type).toBe('snapshot')
    expect(parsed.data.sessions).toEqual([])
  })
})

describe('EventHub', () => {
  it('tracks connection membership', () => {
    const hub = new EventHub(() => Promise.resolve(emptySnapshot()))
    const a = new FakeWs()
    hub.add(a)
    expect(hub.size).toBe(1)
    hub.remove(a)
    expect(hub.size).toBe(0)
  })

  it('sends a snapshot to a single connection on connect', async () => {
    const hub = new EventHub(() => Promise.resolve(snapshotWithProject('p1')))
    const ws = new FakeWs()
    await hub.sendSnapshotTo(ws)
    expect(ws.sent).toHaveLength(1)
    const event = JSON.parse(ws.sent[0]) as { type: string; data: ServerSnapshot }
    expect(event.type).toBe('snapshot')
    expect(event.data.projects[0].slug).toBe('p1')
  })

  it('does not build or broadcast when no one is connected', async () => {
    let builds = 0
    const hub = new EventHub(() => { builds++; return Promise.resolve(emptySnapshot()) })
    await hub.publishSnapshot()
    expect(builds).toBe(0)
  })

  it('broadcasts to all connections, then dedups an unchanged snapshot', async () => {
    let current = emptySnapshot()
    const hub = new EventHub(() => Promise.resolve(current))
    const a = new FakeWs()
    const b = new FakeWs()
    hub.add(a)
    hub.add(b)

    await hub.publishSnapshot()
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)

    // Unchanged → no new traffic.
    await hub.publishSnapshot()
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)

    // Changed → re-broadcast.
    current = snapshotWithProject('p2')
    await hub.publishSnapshot()
    expect(a.sent).toHaveLength(2)
    expect(b.sent).toHaveLength(2)
  })

  it('drops a connection whose send throws', async () => {
    const hub = new EventHub(() => Promise.resolve(snapshotWithProject('p')))
    const bad = new ThrowingWs()
    const good = new FakeWs()
    hub.add(bad)
    hub.add(good)
    await hub.publishSnapshot()
    expect(hub.size).toBe(1)
    expect(good.sent).toHaveLength(1)
  })
})

describe('buildSnapshot', () => {
  it('returns all state slices', async () => {
    const snap = await buildSnapshot()
    expect(Array.isArray(snap.sessions)).toBe(true)
    expect(Array.isArray(snap.stale)).toBe(true)
    expect(Array.isArray(snap.projects)).toBe(true)
    expect(Array.isArray(snap.provisioning)).toBe(true)
    expect(snap.gitAuthFailures).toEqual({})
    expect(Array.isArray(snap.imageBuilds)).toBe(true)
    expect(snap.planUsage).toBeNull()
  })
})

describe('buildSnapshot image builds', () => {
  beforeEach(() => { clearAllImageBuildsForTests() })
  afterEach(() => { clearAllImageBuildsForTests() })

  it('includes tracked image builds', async () => {
    registerImageBuild({
      tag: 'yaac-base:abc', layer: 'base', action: 'build', projectSlug: 'p', reason: 'prewarm',
    })
    const snap = await buildSnapshot()
    expect(snap.imageBuilds.map((b) => b.tag)).toEqual(['yaac-base:abc'])
  })
})

describe('buildSnapshot provisioning', () => {
  beforeEach(() => { clearAllProvisioningForTests() })
  afterEach(() => { clearAllProvisioningForTests() })

  it('includes a provisioning entry that has no live session yet', async () => {
    registerProvisioning({ sessionId: 'prov-1', projectSlug: 'p', tool: 'claude', kind: 'create' })
    const snap = await buildSnapshot()
    expect(snap.provisioning.map((e) => e.sessionId)).toEqual(['prov-1'])
  })

  it('hides a listed session that is still provisioning, keeping the row', async () => {
    // A pod lists as an active session mid-setup (Running + tmux up, but no
    // agent/init windows yet) — the provisioning row must win until the
    // create route removes it, or clients attach to a half-built session.
    vi.mocked(listActiveSessions).mockResolvedValueOnce({
      sessions: [{
        sessionId: 'prov-2', projectSlug: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', blockedHosts: [], forwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ sessionId: 'prov-2', projectSlug: 'p', tool: 'claude', kind: 'create' })
    const snap = await buildSnapshot()
    expect(snap.sessions).toEqual([])
    expect(snap.provisioning.map((e) => e.sessionId)).toEqual(['prov-2'])
  })

  it('lists the session once its provisioning entry is removed (the hand-off)', async () => {
    vi.mocked(listActiveSessions).mockResolvedValue({
      sessions: [{
        sessionId: 'prov-3', projectSlug: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', blockedHosts: [], forwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ sessionId: 'prov-3', projectSlug: 'p', tool: 'claude', kind: 'create' })
    removeProvisioning('prov-3')
    const snap = await buildSnapshot()
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(['prov-3'])
    expect(snap.provisioning).toEqual([])
    vi.mocked(listActiveSessions).mockResolvedValue({ sessions: [], stale: [], gitAuthFailures: {} })
  })
})
