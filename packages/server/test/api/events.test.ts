import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as QueuedWorkspaces from '#domain/workspaces/queued-workspaces'

vi.mock('#domain/workspaces/list', () => ({
  listActiveWorkspaces: vi.fn().mockResolvedValue({ workspaces: [], stale: [], gitAuthFailures: {} }),
}))

vi.mock('#domain/projects/list', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
}))

// The real slice reads the credentials file and triggers upstream
// refreshes; keep snapshot builds inert.
vi.mock('#domain/auth/plan-usage', () => ({
  planUsageForSnapshot: vi.fn().mockResolvedValue(null),
  codexPlanUsageForSnapshot: vi.fn().mockResolvedValue(null),
}))

vi.mock('#domain/workspaces/queued-workspaces', async (importOriginal) => ({
  ...await importOriginal<typeof QueuedWorkspaces>(),
  listHeldWorkspaces: vi.fn().mockResolvedValue([]),
}))

import { EventHub, buildSnapshot } from '#api/events'
import type { WsLike } from '#api/events'
import { listActiveWorkspaces } from '#domain/workspaces/list'
import { listHeldWorkspaces } from '#domain/workspaces/queued-workspaces'
import {
  claimProvisioning, failProvisioning, registerProvisioning, removeProvisioning,
  clearAllProvisioningForTests,
} from '#domain/workspaces/provisioning'
import { installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { ServerSnapshot } from '@yaac/shared/types'

function emptySnapshot(): ServerSnapshot {
  return {
    driver: 'k8s',
    workspaces: [], workspaceGroups: [], stale: [], projects: [], provisioning: [], gitAuthFailures: {},
    queuedWorkspaces: [], heldWorkspaces: [], draftWorkspaces: [],
    imageBuilds: [],
    planUsage: null,
    codexPlanUsage: null,
    forwardBindHost: '127.0.0.1',
  }
}

function snapshotWithProject(projectId: string): ServerSnapshot {
  return {
    ...emptySnapshot(),
    projects: [{ id: projectId, name: 'demo', remoteUrl: 'https://example.com/r.git', addedAt: '2026-01-01', owner: 'u1', workspaceCount: 0, createDefaults: {}, gitCredential: null }],
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
    expect(event.data.projects[0].id).toBe('p1')
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

  // Builds are async, so two in flight can resolve out of order; the older
  // one would then broadcast last and leave `lastSerialized` stale until an
  // unrelated mutation. Serializing keeps the newest snapshot last on the
  // wire.
  it('never lets a slower build overwrite a newer one', async () => {
    const releases: Array<() => void> = []
    let n = 0
    const hub = new EventHub(() => {
      const projectId = `p${++n}`
      // First build resolves LAST — the inversion the ordering must survive.
      return new Promise<ServerSnapshot>((resolve) => {
        releases.push(() => resolve(snapshotWithProject(projectId)))
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
    expect(last.data.projects[0].id).toBe('p2')
  })

  // The trailing call of a coalesced burst often lands mid-build; folding
  // must not drop it, or the final snapshot would predate the burst's end.
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

// The build registry comes from the runtime, so each case installs a fake
// one; building a snapshot with no runtime registered is a wiring bug.

describe('buildSnapshot', () => {
  beforeEach(() => { installFakeWorkspaceDriver() })

  it('returns all state slices', async () => {
    const snap = await buildSnapshot()
    expect(Array.isArray(snap.workspaces)).toBe(true)
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
    installFakeWorkspaceDriver({
      listImageBuilds: () => [{
        id: 'b1',
        tag: 'yaac-base:abc',
        layer: 'base',
        reason: 'prewarm',
        projectIds: ['p'],
        status: 'running',
        startedAt: '2026-01-01 00:00:00',
      }],
    })
    const snap = await buildSnapshot()
    expect(snap.imageBuilds.map((b) => b.tag)).toEqual(['yaac-base:abc'])
  })
})

describe('buildSnapshot provisioning', () => {
  beforeEach(() => { installFakeWorkspaceDriver() })
  beforeEach(() => { clearAllProvisioningForTests() })
  afterEach(() => { clearAllProvisioningForTests() })

  it('includes a provisioning entry that has no live session yet', async () => {
    registerProvisioning({ workspaceId: 'prov-1', projectId: 'p', tool: 'claude', kind: 'create' })
    const snap = await buildSnapshot()
    expect(snap.provisioning.map((e) => e.workspaceId)).toEqual(['prov-1'])
  })

  it('hides a listed session that is still provisioning, keeping the row', async () => {
    // A workspace lists as active mid-setup (running, tmux up, no agent
    // windows yet); the provisioning row must win until the create route
    // removes it, or clients attach to a half-built workspace.
    vi.mocked(listActiveWorkspaces).mockResolvedValueOnce({
      workspaces: [{
        workspaceId: 'prov-2', projectId: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', agentSessions: [],
        blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ workspaceId: 'prov-2', projectId: 'p', tool: 'claude', kind: 'create' })
    const snap = await buildSnapshot()
    expect(snap.workspaces).toEqual([])
    expect(snap.provisioning.map((e) => e.workspaceId)).toEqual(['prov-2'])
  })

  it('hides a held workspace while it restarts', async () => {
    // A restart keeps the row's stop until it succeeds, so the workspace is
    // still held; the provisioning row stands in for it meanwhile.
    vi.mocked(listHeldWorkspaces).mockResolvedValueOnce([{
      workspaceId: 'held-1', projectId: 'p', tool: 'claude', stoppedAt: '2026-01-01 00:00:00',
    }])
    registerProvisioning({ workspaceId: 'held-1', projectId: 'p', tool: 'claude', kind: 'restart' })
    const snap = await buildSnapshot()
    expect(snap.heldWorkspaces).toEqual([])
    expect(snap.provisioning.map((e) => e.workspaceId)).toEqual(['held-1'])
  })

  it('hides a claimed spare under the create row that claimed it', async () => {
    // A claim unhides the spare's row before the create resolves; listing it
    // would show it beside the row still creating it.
    vi.mocked(listActiveWorkspaces).mockResolvedValueOnce({
      workspaces: [{
        workspaceId: 'spare-1', projectId: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', agentSessions: [],
        blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ workspaceId: 'req-1', projectId: 'p', tool: 'claude', kind: 'create' })
    claimProvisioning('req-1', 'spare-1')
    const snap = await buildSnapshot()
    expect(snap.workspaces).toEqual([])
    expect(snap.provisioning).toMatchObject([{ workspaceId: 'req-1', claimedId: 'spare-1' }])
  })

  it('lists a claimed spare once the create that claimed it fails', async () => {
    // The claim succeeded but the route failed afterwards (filing its group,
    // delivering its prompt): the failed row lingers until dismissed, and
    // the claimed workspace must not stay hidden with it.
    vi.mocked(listActiveWorkspaces).mockResolvedValueOnce({
      workspaces: [{
        workspaceId: 'spare-2', projectId: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', agentSessions: [],
        blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ workspaceId: 'req-2', projectId: 'p', tool: 'claude', kind: 'create' })
    claimProvisioning('req-2', 'spare-2')
    failProvisioning('req-2', 'prompt delivery timed out')
    const snap = await buildSnapshot()
    expect(snap.workspaces.map((w) => w.workspaceId)).toEqual(['spare-2'])
    expect(snap.provisioning).toMatchObject([{ workspaceId: 'req-2', error: 'prompt delivery timed out' }])
    expect(snap.provisioning[0].claimedId).toBeUndefined()
  })

  it('lists the session once its provisioning entry is removed (the hand-off)', async () => {
    vi.mocked(listActiveWorkspaces).mockResolvedValue({
      workspaces: [{
        workspaceId: 'prov-3', projectId: 'p', tool: 'claude',
        status: 'waiting', createdAt: '2026-01-01 00:00:00', agentSessions: [],
        blockedHosts: [], forwardedPorts: [], unforwardedPorts: [],
      }],
      stale: [],
      gitAuthFailures: {},
    })
    registerProvisioning({ workspaceId: 'prov-3', projectId: 'p', tool: 'claude', kind: 'create' })
    removeProvisioning('prov-3')
    const snap = await buildSnapshot()
    expect(snap.workspaces.map((s) => s.workspaceId)).toEqual(['prov-3'])
    expect(snap.provisioning).toEqual([])
    vi.mocked(listActiveWorkspaces).mockResolvedValue({ workspaces: [], stale: [], gitAuthFailures: {} })
  })
})
