/**
 * The k8s driver's attach and detach: `startK8sDriver`, `stopK8sDriver`,
 * `releaseK8sDriver`.
 *
 * These tests are about order: recovery must run against a working cluster
 * that nothing is watching yet, and the reconcile loop must not start before
 * the attach completes. The informer cache, proxy stream, bootstrap and host
 * reapers are mocked at their barrels so the sequencing runs for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DriverSinks, RuntimeHandle } from '#drivers/contract'

const order: string[] = []
const onDeltaHandlers: Array<(source: string) => void> = []
const cacheStub = {
  onDelta: (fn: (source: string) => void) => { onDeltaHandlers.push(fn) },
  start: () => { order.push('cache.start') },
  stop: () => { order.push('cache.stop') },
  workspacePods: () => [{ workspaceId: 'w1', projectSlug: 'demo', jobName: 'yaac-demo-w1' }],
}

vi.mock('#drivers/k8s/substrate', () => ({
  ClusterCache: class { constructor() { return cacheStub } },
  kubectlApply: vi.fn(() => { order.push('wall'); return Promise.resolve() }),
  invalidateRelayAddr: vi.fn(),
  setActiveClusterCache: vi.fn((c: unknown) => { order.push(c ? 'cache.registered' : 'cache.cleared') }),
}))
vi.mock('#drivers/k8s/cluster', () => ({
  buildServerIngressNpManifest: vi.fn((cidrs: string[]) => ({ kind: 'NetworkPolicy', cidrs })),
  buildProxyEgressNpManifest: vi.fn((cidrs: string[]) => ({ kind: 'NetworkPolicy', proxyEgress: cidrs })),
  ensureMainRegistry: vi.fn().mockResolvedValue(undefined),
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.2/32', '10.89.0.3/32']),
  gcOrphanProjectRegistries: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#drivers/k8s/images', () => ({
  deleteLeakedBuilderPods: vi.fn(() => { order.push('bootstrap'); return Promise.resolve() }),
}))
vi.mock('#drivers/k8s/forwarders', () => ({
  PortDetectorManager: class { sync = vi.fn(); stopAll = vi.fn() },
  stopAllWorkspaceForwarders: vi.fn(() => { order.push('forwarders.released') }),
}))
vi.mock('#drivers/k8s/egress', () => ({
  proxyClient: {
    disconnect: vi.fn(() => { order.push('proxy.disconnect') }),
    rollIfStale: vi.fn(() => { order.push('proxy.roll'); return Promise.resolve() }),
  },
}))
vi.mock('#drivers/k8s/workspaces', () => ({
  runtimeHandleFromPod: (p: { workspaceId: string }) => ({ workspaceId: p.workspaceId }),
}))

import { startK8sDriver, stopK8sDriver, releaseK8sDriver, triggerFor } from '#drivers/k8s/lifecycle'
import { deleteLeakedBuilderPods } from '#drivers/k8s/images'
import { ensureMainRegistry } from '#drivers/k8s/cluster'
import { kubectlApply } from '#drivers/k8s/substrate'
import { _resetWorkspaceListChangedForTests, onWorkspaceListChanged } from '#notify'

let reported: { triggers: string[]; workspaces: RuntimeHandle[][] }

function sinks(): DriverSinks {
  return {
    trigger: (s) => { order.push(`trigger:${s}`); reported.triggers.push(s) },
    workspacesChanged: (w) => { reported.workspaces.push(w) },
    recover: async () => { order.push('recover'); await Promise.resolve() },
    attached: () => { order.push('attached') },
  }
}

beforeEach(() => {
  order.length = 0
  onDeltaHandlers.length = 0
  reported = { triggers: [], workspaces: [] }
})

afterEach(() => {
  stopK8sDriver()
  vi.clearAllMocks()
})

describe('startK8sDriver', () => {
  it('recovers against a usable substrate before anything watches it', async () => {
    await startK8sDriver(sinks())

    // Recovery rebuilds what the last server left running, so it needs the
    // cluster bootstrapped first and must finish before deltas start.
    // `attached` comes last, so the reconcile loop never starts early.
    expect(order.indexOf('bootstrap')).toBeLessThan(order.indexOf('recover'))
    expect(order.indexOf('recover')).toBeLessThan(order.indexOf('cache.start'))
    expect(order.indexOf('cache.start')).toBeLessThan(order.indexOf('attached'))
    // An upgrade rolls the proxy at once rather than at the next launch.
    expect(order).toContain('proxy.roll')
  })

  it('re-renders the node half of the server wall from the live node list', async () => {
    await startK8sDriver(sinks())

    // Install applies this policy too, but nodes can be added later: a server
    // pod moved to a new node must admit that node's kubelet or never go
    // Ready. It is part of the bootstrap, so before recovery.
    expect(vi.mocked(kubectlApply)).toHaveBeenCalledWith({
      kind: 'NetworkPolicy', cidrs: ['10.89.0.2/32', '10.89.0.3/32'],
    })
    expect(order.indexOf('wall')).toBeLessThan(order.indexOf('recover'))
  })

  it('applies the proxy\'s egress policy on every start, not only on a proxy bootstrap', async () => {
    await startK8sDriver(sinks())

    // The proxy bootstrap is skipped when the proxy is current, so this
    // policy is applied here too; without it a `*` allowlist could reach the
    // kind fronting's node port as the server's owner.
    expect(vi.mocked(kubectlApply)).toHaveBeenCalledWith({
      kind: 'NetworkPolicy', proxyEgress: ['10.89.0.2/32', '10.89.0.3/32'],
    })
  })

  it('reports the workspace set as handles, never as pods', async () => {
    await startK8sDriver(sinks())
    onDeltaHandlers.forEach((fn) => fn('workspace-pods'))

    // The layers above know nothing of pods, so pods are mapped to
    // workspaces here.
    expect(reported.workspaces).toEqual([[{ workspaceId: 'w1' }]])
    expect(reported.triggers).toContain('workspaces')
  })

  it('routes the proxy’s outputs: records to the snapshot, a captured rotation to the pass', async () => {
    _resetWorkspaceListChangedForTests()
    let notified = 0
    onWorkspaceListChanged(() => { notified += 1 })
    await startK8sDriver(sinks())

    // A blocked host only updates the UI; it is not reconcile work.
    onDeltaHandlers.forEach((fn) => fn('proxy-state'))
    expect(notified).toBe(1)
    expect(reported.triggers).not.toContain('proxy-state')
    // `credential-adopt` waits on captured credential rotations.
    onDeltaHandlers.forEach((fn) => fn('proxy-refreshed'))
    expect(reported.triggers).toContain('proxy-refreshed')
    expect(notified).toBe(1)
    _resetWorkspaceListChangedForTests()
  })

  it('attaches even when the cluster bootstrap fails', async () => {
    vi.mocked(ensureMainRegistry).mockRejectedValueOnce(new Error('no cluster'))

    await startK8sDriver(sinks())

    // A server without a working cluster still serves projects and auth, so a
    // failed bootstrap must not fail the attach.
    expect(order).toContain('attached')
  })

  it('still bootstraps the rest when the leaked builder pods cannot be deleted', async () => {
    vi.mocked(deleteLeakedBuilderPods).mockRejectedValueOnce(new Error('forbidden'))

    await startK8sDriver(sinks())

    expect(vi.mocked(ensureMainRegistry)).toHaveBeenCalled()
    expect(order).toContain('wall')
  })
})

describe('stopK8sDriver', () => {
  it('clears the registered cache before stopping it, so nothing reads a dead one', async () => {
    await startK8sDriver(sinks())
    order.length = 0
    stopK8sDriver()

    expect(order.indexOf('cache.cleared')).toBeLessThan(order.indexOf('cache.stop'))
  })

  it('is safe to call without a start, and twice', () => {
    expect(() => { stopK8sDriver(); stopK8sDriver() }).not.toThrow()
  })
})

describe('releaseK8sDriver', () => {
  it('lets go of the host only here, never during stop', async () => {
    await startK8sDriver(sinks())
    order.length = 0
    stopK8sDriver()
    // Forwarders and the control tunnel survive until release, since a reap
    // during the reconcile drain between stop and release still tears down
    // its workspace's forwards.
    expect(order).not.toContain('forwarders.released')

    releaseK8sDriver()
    expect(order).toContain('forwarders.released')
    expect(order).toContain('proxy.disconnect')
  })
})

describe('triggerFor', () => {
  it('translates the two substrate edges the mediators name', () => {
    expect(triggerFor('workspace-pods')).toBe('workspaces')
    expect(triggerFor('workspace-jobs')).toBe('units')
  })

})
