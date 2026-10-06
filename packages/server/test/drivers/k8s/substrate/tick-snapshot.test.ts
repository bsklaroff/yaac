import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

import {
  createTickSnapshot,
  dataDirHash,
  setActiveClusterCache,
  type ClusterCache,
  type PodInfo,
} from '#drivers/k8s/substrate'

const SID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'

function rawPod(name: string) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'test-ns',
      labels: {
        'batch.kubernetes.io/job-name': `yaac-demo-${SID}`,
        'yaac.workspace-id': SID,
        'yaac.project-id': '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c',
        'yaac.tool': 'claude',
        'yaac.data-dir-hash': dataDirHash(),
      },
      creationTimestamp: '2026-06-01T00:00:00Z',
    },
    status: { phase: 'Running' },
  }
}

/** A ClusterCache whose informers are all healthy, as the server publishes. */
function healthyCache(): ClusterCache {
  return {
    healthy: () => true,
    workspacePods: () => [{ podName: 'cached' } as PodInfo],
    workspaceJobs: () => [],
  } as unknown as ClusterCache
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  fakeCluster.seed(rawPod('yaac-demo-p1'))
})

afterEach(() => {
  setActiveClusterCache(null)
  vi.unstubAllEnvs()
})

describe('createTickSnapshot', () => {
  it('is lazy — creating a snapshot lists nothing', () => {
    createTickSnapshot()
    expect(fakeCluster.calls).toEqual([])
  })

  it('defaults to resync=true for direct invocations', () => {
    expect(createTickSnapshot().resync).toBe(true)
    expect(createTickSnapshot(false).resync).toBe(false)
  })

  it('lists each kind at most once per snapshot and maps the rows', async () => {
    const snap = createTickSnapshot()
    const pods = await snap.pods()
    expect(pods.map((p) => p.podName)).toEqual(['yaac-demo-p1'])
    expect(pods[0].workspaceId).toBe(SID)
    expect(await snap.pods()).toBe(pods)
    await snap.jobs()
    await snap.jobs()
    expect(fakeCluster.callsOf('list')).toHaveLength(2)
    // Each fallback is scoped install-wide by data-dir hash.
    expect(fakeCluster.callsOf('list', 'Pod')[0]).toMatchObject({
      namespace: 'test-ns',
      labelSelector: expect.stringMatching(/^yaac\.data-dir-hash=[0-9a-f]{16},yaac\.workspace-id$/) as unknown,
    })
  })

  it('separate snapshots list independently', async () => {
    await createTickSnapshot().pods()
    await createTickSnapshot().pods()
    expect(fakeCluster.callsOf('list')).toHaveLength(2)
  })

  it('a failed listing stays failed for the whole snapshot (no per-consumer retry)', async () => {
    fakeCluster.intercept(() => { throw apiError(403, 'forbidden') })
    const snap = createTickSnapshot()
    await expect(snap.pods()).rejects.toThrow('403')
    await expect(snap.pods()).rejects.toThrow('403')
    expect(fakeCluster.callsOf('list')).toHaveLength(1)
  })

  it('answers from a healthy active cluster cache without listing', async () => {
    setActiveClusterCache(healthyCache())
    const snap = createTickSnapshot()
    expect((await snap.pods()).map((p) => p.podName)).toEqual(['cached'])
    expect(fakeCluster.calls).toEqual([])
  })

  it('falls back to a live list when the cache source is unhealthy', async () => {
    // A degraded watch must never read as "the object is gone".
    const cache = healthyCache()
    vi.spyOn(cache, 'healthy').mockReturnValue(false)
    setActiveClusterCache(cache)
    const snap = createTickSnapshot()
    expect((await snap.pods()).map((p) => p.podName)).toEqual(['yaac-demo-p1'])
    await snap.jobs()
    expect(fakeCluster.callsOf('list')).toHaveLength(2)
  })
})
