/**
 * The k8s driver's attach and detach — `startK8sDriver`, `stopK8sDriver`,
 * `releaseK8sDriver`.
 *
 * What these own is ORDER, and it is the whole reason the driver calls back
 * rather than letting the caller sequence the attach itself: recovery has to
 * run against a usable substrate that nothing is watching yet, and the
 * reconcile loop must not start against one that has not been attached at
 * all. Neither is visible in a type, and the code this covers is what the
 * driver split moved most of.
 *
 * Mocked at the folder barrels — the informer cache, the proxy stream, the
 * bootstrap and the host reapers — so the sequencing runs for real and the
 * assertions land on what the caller is told, in what order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DriverSinks, RuntimeHandle } from '#drivers/contract'

const order: string[] = []
const onDeltaHandlers: Array<(source: string) => void> = []
const cacheStub = {
  onDelta: (fn: (source: string) => void) => { onDeltaHandlers.push(fn) },
  start: () => { order.push('cache.start') },
  stop: () => { order.push('cache.stop') },
  worktreePods: () => [{ worktreeId: 'w1', projectSlug: 'demo', jobName: 'yaac-demo-w1' }],
}

vi.mock('#drivers/k8s/substrate', () => ({
  ClusterCache: class { constructor() { return cacheStub } },
  ensurePriorityClasses: vi.fn().mockResolvedValue(undefined),
  invalidateRelayAddr: vi.fn(),
  setActiveClusterCache: vi.fn((c: unknown) => { order.push(c ? 'cache.registered' : 'cache.cleared') }),
}))
vi.mock('#drivers/k8s/cluster', () => ({
  ensureMainRegistry: vi.fn().mockResolvedValue(undefined),
  ensureNamespace: vi.fn(() => { order.push('bootstrap'); return Promise.resolve() }),
  gcOrphanProjectRegistries: vi.fn().mockResolvedValue(undefined),
  sweepLegacyVclusterState: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('#drivers/k8s/forwarders', () => ({
  PortDetectorManager: class { sync = vi.fn(); stopAll = vi.fn() },
  stopAllWorktreeForwarders: vi.fn(() => { order.push('forwarders.released') }),
}))
vi.mock('#drivers/k8s/egress', () => ({
  PROXY_CHANGE_SOURCES: ['proxy-reconnect'],
  ProxyEventStream: class {
    constructor(readonly raise: (s: string) => void) {}
    start = (): void => { order.push('proxy.start') }
    stop = vi.fn()
  },
  configureProxyCredentials: vi.fn(),
  proxyClient: { disconnect: vi.fn(() => { order.push('proxy.disconnect') }) },
}))
vi.mock('#drivers/k8s/view', () => ({
  runtimeHandleFromPod: (p: { worktreeId: string }) => ({ workspaceId: p.worktreeId }),
}))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import { startK8sDriver, stopK8sDriver, releaseK8sDriver, triggerFor } from '#drivers/k8s/lifecycle'
import { ensureNamespace } from '#drivers/k8s/cluster'
import { configureProxyCredentials } from '#drivers/k8s/egress'

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
    await startK8sDriver(sinks(), {})

    // The ordering IS the contract: recovery rebuilds what the last server
    // left running, so it has to see a bootstrapped cluster (after) and must
    // not race the first deltas (before). `attached` closes the sequence, so
    // a caller starting the reconcile loop from it never runs against a
    // substrate that is not up.
    expect(order.indexOf('bootstrap')).toBeLessThan(order.indexOf('recover'))
    expect(order.indexOf('recover')).toBeLessThan(order.indexOf('cache.start'))
    expect(order.indexOf('cache.start')).toBeLessThan(order.indexOf('attached'))
  })

  it('reports the workspace set as handles, never as pods', async () => {
    await startK8sDriver(sinks(), {})
    onDeltaHandlers.forEach((fn) => fn('worktree-pods'))

    // The machinery above has no word for a pod, so the boundary mapper runs
    // here rather than at the receiver.
    expect(reported.workspaces).toEqual([[{ workspaceId: 'w1' }]])
    expect(reported.triggers).toContain('workspaces')
  })

  it('wires a supplied identity reader, and leaves it unwired without one', async () => {
    await startK8sDriver(sinks(), {})
    expect(configureProxyCredentials).not.toHaveBeenCalled()

    const sshIdentities = vi.fn().mockResolvedValue([])
    await startK8sDriver(sinks(), { sshIdentities })
    // Absent must degrade to "no ssh injection" rather than clearing what a
    // live proxy is using, so nothing is registered when nothing was handed
    // in — which is what an entrypoint that composes a driver without being
    // the server gets.
    expect(configureProxyCredentials).toHaveBeenCalledWith({ listSshEntries: sshIdentities })
  })

  it('attaches even when the cluster bootstrap fails', async () => {
    vi.mocked(ensureNamespace).mockRejectedValueOnce(new Error('no cluster'))

    await startK8sDriver(sinks(), {})

    // A server with no usable cluster still serves project and auth requests
    // and says so when a create asks for one — so a failed bootstrap must not
    // take the attach down with it.
    expect(order).toContain('attached')
  })
})

describe('stopK8sDriver', () => {
  it('clears the registered cache before stopping it, so nothing reads a dead one', async () => {
    await startK8sDriver(sinks(), {})
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
    await startK8sDriver(sinks(), {})
    order.length = 0
    stopK8sDriver()
    // The forwarders and the control tunnel survive the reconcile drain that
    // runs between the two: a reap tick in that drain still tears its
    // worktree's forwards down.
    expect(order).not.toContain('forwarders.released')

    releaseK8sDriver()
    expect(order).toContain('forwarders.released')
    expect(order).toContain('proxy.disconnect')
  })
})

describe('triggerFor', () => {
  it('translates the two substrate edges the mediators name', () => {
    expect(triggerFor('worktree-pods')).toBe('workspaces')
    expect(triggerFor('worktree-jobs')).toBe('units')
  })

})
