import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('#domain/worktrees/list', () => ({
  listActiveWorktrees: vi.fn().mockResolvedValue({ worktrees: [], stale: [], gitAuthFailures: {} }),
}))

vi.mock('#domain/projects/list', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
}))

// The real slice reads the credentials file and kicks upstream refreshes —
// keep unit-test snapshot builds inert.
vi.mock('#domain/auth/plan-usage', () => ({
  planUsageForSnapshot: vi.fn().mockResolvedValue(null),
  codexPlanUsageForSnapshot: vi.fn().mockResolvedValue(null),
}))

import { EventHub, buildSnapshot, serializeEvent } from '#api/events'
import type { WsLike } from '#api/events'
import { listActiveWorktrees } from '#domain/worktrees/list'
import { registerProvisioning, removeProvisioning, clearAllProvisioningForTests } from '#domain/worktrees/provisioning'
import { installFakeWorktreeDriver } from '@yaac/test-utils/fake-driver'
import type { ServerSnapshot } from '@yaac/shared/types'

function emptySnapshot(): ServerSnapshot {
  return {
    worktrees: [], worktreeGroups: [], stale: [], projects: [], provisioning: [], gitAuthFailures: {},
    imageBuilds: [],
    planUsage: null,
    codexPlanUsage: null,
    forwardBindHost: '127.0.0.1',
  }
}

function snapshotWithProject(slug: string): ServerSnapshot {
  return {
    ...emptySnapshot(),
    projects: [{ slug, remoteUrl: 'https://example.com/r.git', addedAt: '2026-01-01', worktreeCount: 0 }],
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
    expect(parsed.data.worktrees).toEqual([])
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

  // A build is several awaited substrate reads long, so two in flight can
  // resolve out of order. Left concurrent, the older one broadcasts last and
  // sets `lastSerialized` to state that has already been superseded — after
  // which the diff believes clients hold the stale snapshot and nothing
  // repairs it until the next unrelated mutation. Serializing is what makes
  // the last thing on the wire also the newest.
  it('never lets a slower build overwrite a newer one', async () => {
    const releases: Array<() => void> = []
    let n = 0
    const hub = new EventHub(() => {
      const slug = `p${++n}`
      // First build resolves LAST — the inversion the ordering must survive.
      return new Promise<ServerSnapshot>((resolve) => {
        releases.push(() => resolve(snapshotWithProject(slug)))
      })
    })
    const ws = new FakeWs()
    hub.add(ws)

    const publish = hub.publishSnapshot()
    await Promise.resolve()
    void hub.publishSnapshot()
    await Promise.resolve()

    // Only one build is in flight; the second call folded into it.
    expect(releases).toHaveLength(1)
    releases[0]()
    await new Promise((r) => setImmediate(r))

    // Folding does not lose the request: a second build runs after the first.
    expect(releases).toHaveLength(2)
    releases[1]()
    await publish

    const last = JSON.parse(ws.sent[ws.sent.length - 1]) as { data: ServerSnapshot }
    expect(last.data.projects[0].slug).toBe('p2')
  })

  // The trailing call of a coalesced burst is exactly when a second publish
  // lands mid-build, so folding must not swallow it — otherwise the last
  // snapshot after a storm is the one built before the storm ended.
  it('runs a final build for a publish that arrived mid-build', async () => {
    let builds = 0
    let current = emptySnapshot()
    const hub = new EventHub(() => {
      builds++
      const snapshot = current
      return Promise.resolve().then(() => snapshot)
    })
    hub.add(new FakeWs())

    const running = hub.publishSnapshot()
    current = snapshotWithProject('late')
    void hub.publishSnapshot()
    await running
    expect(builds).toBe(2)
  })
})

// The build registry is the runtime's, so the snapshot asks for it across
// the boundary — which is also why every case below installs a fake one:
// a snapshot build with no runtime registered is a wiring bug, and says so.

describe('buildSnapshot', () => {
  beforeEach(() => { installFakeWorktreeDriver() })

  it('returns all state slices', async () => {
    const snap = await buildSnapshot()
    expect(Array.isArray(snap.worktrees)).toBe(true)
    expect(Array.isArray(snap.stale)).toBe(true)
    expect(Array.isArray(snap.projects)).toBe(true)
    expect(Array.isArray(snap.provisioning)).toBe(true)
    expect(snap.gitAuthFailures).toEqual({})
    expect(Array.isArray(snap.imageBuilds)).toBe(true)
    expect(snap.planUsage).toBeNull()
    expect(snap.codexPlanUsage).toBeNull()
  })
})

describe('buildSnapshot image builds', () => {
  it('includes the builds the runtime reports', async () => {
    installFakeWorktreeDriver({
      listImageBuilds: () => [{
        id: 'b1',
        tag: 'yaac-base:abc',
        layer: 'base',
        action: 'build',
        reason: 'prewarm',
        projectSlugs: ['p'],
        status: 'running',
        startedAt: '2026-01-01 00:00:00',
      }],
    })
    const snap = await buildSnapshot()
    expect(snap.imageBuilds.map((b) => b.tag)).toEqual(['yaac-base:abc'])
  })
})

describe('buildSnapshot provisioning', () => {
  beforeEach(() => { installFakeWorktreeDriver() })
  beforeEach(() => { clearAllProvisioningForTests() })
  afterEach(() => { clearAllProvisioningForTests() })

  it('includes a provisioning entry that has no live session yet', async () => {
    registerProvisioning({ worktreeId: 'prov-1', projectSlug: 'p', tool: 'claude', kind: 'create' })
    const snap = await buildSnapshot()
    expect(snap.provisioning.map((e) => e.worktreeId)).toEqual(['prov-1'])
  })

  it('hides a listed session that is still provisioning, keeping the row', async () => {
    // A pod lists as an active session mid-setup (Running + tmux up, but no
    // agent/init windows yet) — the provisioning row must win until the
    // create route removes it, or clients attach to a half-built session.
    vi.mocked(listActiveWorktrees).mockResolvedValueOnce({
      worktrees: [{
        worktreeId: 'prov-2', projectSlug: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', agentSessions: [],
        blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ worktreeId: 'prov-2', projectSlug: 'p', tool: 'claude', kind: 'create' })
    const snap = await buildSnapshot()
    expect(snap.worktrees).toEqual([])
    expect(snap.provisioning.map((e) => e.worktreeId)).toEqual(['prov-2'])
  })

  it('lists the session once its provisioning entry is removed (the hand-off)', async () => {
    vi.mocked(listActiveWorktrees).mockResolvedValue({
      worktrees: [{
        worktreeId: 'prov-3', projectSlug: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', agentSessions: [],
        blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ worktreeId: 'prov-3', projectSlug: 'p', tool: 'claude', kind: 'create' })
    removeProvisioning('prov-3')
    const snap = await buildSnapshot()
    expect(snap.worktrees.map((s) => s.worktreeId)).toEqual(['prov-3'])
    expect(snap.provisioning).toEqual([])
    vi.mocked(listActiveWorktrees).mockResolvedValue({ worktrees: [], stale: [], gitAuthFailures: {} })
  })
})
