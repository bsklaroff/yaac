import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as podsModule from '#platform/k8s/pods'
import type * as clusterModule from '#features/cluster'

// The snapshot's four listers are what this covers; everything else in
// these modules stays real, because the cluster barrel it reads the vcluster
// half from pulls the rest of the feature in with it.
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...(await importOriginal<typeof podsModule>()),
  listSessionPods: vi.fn(),
  listSessionJobs: vi.fn(),
}))
vi.mock('#features/cluster', async (importOriginal) => ({
  ...(await importOriginal<typeof clusterModule>()),
  listVclusterNamespaces: vi.fn(),
  listVclusterPods: vi.fn(),
  listVclusterServices: vi.fn(),
}))
vi.mock('#platform/k8s/cluster-cache', () => ({
  getActiveClusterCache: vi.fn(),
}))

import { createTickSnapshot } from '#platform/k8s/tick-snapshot'
import { listSessionPods, listSessionJobs, type SessionPod } from '#platform/k8s/pods'
import {
  listVclusterNamespaces,
  listVclusterPods,
  listVclusterServices,
  type VclusterPod,
} from '#features/cluster'
import { getActiveClusterCache, type ClusterCache } from '#platform/k8s/cluster-cache'

const mockPods = vi.mocked(listSessionPods)
const mockJobs = vi.mocked(listSessionJobs)
const mockVclusters = vi.mocked(listVclusterNamespaces)
const mockVcPods = vi.mocked(listVclusterPods)
const mockVcServices = vi.mocked(listVclusterServices)
const mockGetCache = vi.mocked(getActiveClusterCache)

const POD = { podName: 'p1' } as SessionPod
const CACHED_POD = { podName: 'cached' } as SessionPod
const VC = { namespace: 'yvc-ns', name: 'yvc-abc' }

/** A fake ClusterCache whose informers are all healthy. */
function healthyCache(): ClusterCache {
  return {
    healthy: () => true,
    sessionPods: () => [CACHED_POD],
    sessionJobs: () => [],
    vclusterNamespaces: () => [],
    vclusterPods: () => [{ name: 'vp', podIP: '10.0.0.9' }],
    vclusterServices: () => [{ name: 'yaac-proxy', labels: {} }],
    vclusterConfigMaps: () => [{ name: 'yaac-redirect-claim-x-yaac-x-vc', data: {} }],
  } as unknown as ClusterCache
}

beforeEach(() => {
  vi.resetAllMocks()
  mockGetCache.mockReturnValue(null)
  mockPods.mockResolvedValue([POD])
  mockJobs.mockResolvedValue([])
  mockVclusters.mockResolvedValue([])
  mockVcPods.mockResolvedValue([])
  mockVcServices.mockResolvedValue([])
})

describe('createTickSnapshot', () => {
  it('is lazy — creating a snapshot fetches nothing', () => {
    createTickSnapshot()
    expect(mockPods).not.toHaveBeenCalled()
    expect(mockJobs).not.toHaveBeenCalled()
    expect(mockVclusters).not.toHaveBeenCalled()
  })

  it('defaults to resync=true for direct invocations', () => {
    expect(createTickSnapshot().resync).toBe(true)
    expect(createTickSnapshot(false).resync).toBe(false)
  })

  it('fetches each listing at most once and shares the result', async () => {
    const snap = createTickSnapshot()
    expect(await snap.pods()).toEqual([POD])
    expect(await snap.pods()).toEqual([POD])
    await snap.jobs()
    await snap.jobs()
    await snap.vclusters()
    await snap.vclusters()
    await snap.vclusterPods(VC.namespace)
    await snap.vclusterPods(VC.namespace)
    await snap.vclusterServices(VC)
    await snap.vclusterServices(VC)
    expect(mockPods).toHaveBeenCalledTimes(1)
    expect(mockJobs).toHaveBeenCalledTimes(1)
    expect(mockVclusters).toHaveBeenCalledTimes(1)
    expect(mockVcPods).toHaveBeenCalledTimes(1)
    expect(mockVcServices).toHaveBeenCalledTimes(1)
  })

  it('memoizes vcluster getters per namespace, not globally', async () => {
    const snap = createTickSnapshot()
    await snap.vclusterPods('ns-a')
    await snap.vclusterPods('ns-b')
    expect(mockVcPods).toHaveBeenCalledTimes(2)
    expect(mockVcPods).toHaveBeenCalledWith('ns-a')
    expect(mockVcPods).toHaveBeenCalledWith('ns-b')
  })

  it('separate snapshots fetch independently', async () => {
    await createTickSnapshot().pods()
    await createTickSnapshot().pods()
    expect(mockPods).toHaveBeenCalledTimes(2)
  })

  it('a failed listing stays failed for the whole snapshot (no per-consumer retry)', async () => {
    mockPods.mockRejectedValue(new Error('apiserver down'))
    const snap = createTickSnapshot()
    await expect(snap.pods()).rejects.toThrow('apiserver down')
    await expect(snap.pods()).rejects.toThrow('apiserver down')
    expect(mockPods).toHaveBeenCalledTimes(1)
  })

  it('answers from a healthy active cluster cache without listing', async () => {
    mockGetCache.mockReturnValue(healthyCache())
    const snap = createTickSnapshot()
    expect(await snap.pods()).toEqual([CACHED_POD])
    expect(await snap.vclusterPods(VC.namespace))
      .toEqual([{ name: 'vp', podIP: '10.0.0.9' } as VclusterPod])
    expect(await snap.vclusterServices(VC)).toEqual([{ name: 'yaac-proxy', labels: {} }])
    expect(mockPods).not.toHaveBeenCalled()
    expect(mockVcPods).not.toHaveBeenCalled()
    expect(mockVcServices).not.toHaveBeenCalled()
  })

  it('falls back to a live list when the cache source is unhealthy', async () => {
    const cache = healthyCache()
    vi.spyOn(cache, 'healthy').mockReturnValue(false)
    vi.spyOn(cache, 'vclusterPods').mockReturnValue(null)
    vi.spyOn(cache, 'vclusterServices').mockReturnValue(null)
    mockGetCache.mockReturnValue(cache)
    const snap = createTickSnapshot()
    expect(await snap.pods()).toEqual([POD])
    await snap.vclusterPods(VC.namespace)
    await snap.vclusterServices(VC)
    expect(mockPods).toHaveBeenCalledTimes(1)
    expect(mockVcPods).toHaveBeenCalledWith(VC.namespace)
    expect(mockVcServices).toHaveBeenCalledWith(VC.namespace, VC.name)
  })
})
