import { describe, it, expect, vi, beforeEach } from 'vitest'
import { passViewFixture } from '@yaac/test-utils/fake-driver'

const mockAttach = vi.hoisted(() => vi.fn())
const mockRegister = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/egress/proxy-client', () => ({
  proxyClient: { attachIfRunning: mockAttach, registerVclusterAttribution: mockRegister },
}))
vi.mock('#drivers/k8s/substrate/tick-snapshot', () => ({ createTickSnapshot: vi.fn() }))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  buildVclusterAttribution,
  reconcileVclusterAttribution,
  _resetVclusterAttributionForTests,
} from '#drivers/k8s/egress/vcluster-attribution'
import type { TickSnapshot } from '#drivers/k8s/substrate/tick-snapshot'
import type { VclusterNamespaceInfo, VclusterPod } from '#drivers/k8s/substrate/vcluster-objects'
import { serverLog } from '#log'

const mockLog = vi.mocked(serverLog)

const vc = (sid: string, ns: string): VclusterNamespaceInfo =>
  ({ name: `yvc-${sid}`, worktreeId: sid, namespace: ns, creationTimestamp: '' })

/** Fake one pass's cluster view; only the vcluster getters matter here. */
function tick(opts: {
  vclusters?: VclusterNamespaceInfo[]
  podsByNs?: Record<string, VclusterPod[]>
} = {}): TickSnapshot {
  return {
    resync: true,
    pods: () => Promise.resolve([]),
    jobs: () => Promise.resolve([]),
    vclusters: () => Promise.resolve(opts.vclusters ?? []),
    vclusterPods: (ns: string) => Promise.resolve(opts.podsByNs?.[ns] ?? []),
    vclusterServices: () => Promise.resolve([]),
    vclusterConfigMaps: () => Promise.resolve([]),
  }
}

/** The pass view a reconcile step is handed, over the substrate view above. */
const snap = (opts: Parameters<typeof tick>[0] = {}) => passViewFixture(tick(opts))

beforeEach(() => {
  vi.clearAllMocks()
  _resetVclusterAttributionForTests()
  mockAttach.mockResolvedValue(true)
  mockRegister.mockResolvedValue(undefined)
})

describe('buildVclusterAttribution', () => {
  it('maps every vcluster pod IP to its owning outer session', async () => {
    const snapshot = tick({
      vclusters: [vc('s1', 'yaac-vc-1'), vc('s2', 'yaac-vc-2')],
      podsByNs: {
        'yaac-vc-1': [{ name: 'p1', podIP: '10.0.0.1', labels: {} }, { name: 'p2', podIP: '10.0.0.2', labels: {} }],
        'yaac-vc-2': [{ name: 'p3', podIP: '10.0.0.3', labels: {} }],
      },
    })
    expect(await buildVclusterAttribution(snapshot)).toEqual({
      '10.0.0.1': 's1', '10.0.0.2': 's1', '10.0.0.3': 's2',
    })
  })

  it('skips pods with no IP and is empty with no vclusters', async () => {
    const snapshot = tick({
      vclusters: [vc('s1', 'yaac-vc-1')],
      podsByNs: { 'yaac-vc-1': [{ name: 'no-ip-yet', labels: {} }] },
    })
    expect(await buildVclusterAttribution(snapshot)).toEqual({})

    expect(await buildVclusterAttribution(tick())).toEqual({})
  })
})

describe('reconcileVclusterAttribution', () => {
  const ONE_POD = {
    vclusters: [vc('s1', 'yaac-vc-1')],
    podsByNs: { 'yaac-vc-1': [{ name: 'p1', podIP: '10.0.0.1', labels: {} }] },
  }

  it('pushes the attribution map to the proxy when it is attachable', async () => {
    await reconcileVclusterAttribution(snap(ONE_POD))
    expect(mockRegister).toHaveBeenCalledWith({ '10.0.0.1': 's1' })
  })

  it('re-pushes a non-empty map on every run (proxy-restart recovery)', async () => {
    await reconcileVclusterAttribution(snap(ONE_POD))
    await reconcileVclusterAttribution(snap(ONE_POD))
    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(mockRegister).toHaveBeenNthCalledWith(2, { '10.0.0.1': 's1' })
  })

  it('pushes an empty map only on the transition to empty', async () => {
    await reconcileVclusterAttribution(snap(ONE_POD))
    expect(mockRegister).toHaveBeenNthCalledWith(1, { '10.0.0.1': 's1' })

    // The last vcluster is gone: the empty map evicts the stale IP — once.
    await reconcileVclusterAttribution(snap())
    expect(mockRegister).toHaveBeenNthCalledWith(2, {})

    // Still empty: no redundant push (and no attach probe spam).
    await reconcileVclusterAttribution(snap())
    expect(mockRegister).toHaveBeenCalledTimes(2)
  })

  it('never bootstraps the proxy: no push when it is not running', async () => {
    mockAttach.mockResolvedValue(false)
    await reconcileVclusterAttribution(snap(ONE_POD))
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('logs a failed push and retries it on the next run (lastPushed stays unset)', async () => {
    mockRegister.mockRejectedValueOnce(new Error('proxy hiccup'))
    // An empty map isolates the memo: it is only re-pushed while unrecorded.
    await reconcileVclusterAttribution(snap())
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(String(mockLog.mock.calls[0][0])).toContain('proxy hiccup')

    // The failure did not record the push — the next run pushes again...
    await reconcileVclusterAttribution(snap())
    expect(mockRegister).toHaveBeenCalledTimes(2)

    // ...and the success did, so a third still-empty run is a no-op.
    await reconcileVclusterAttribution(snap())
    expect(mockRegister).toHaveBeenCalledTimes(2)
  })
})
