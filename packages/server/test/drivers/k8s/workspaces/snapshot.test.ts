import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'
import { createRuntimeSnapshot } from '#drivers/k8s/workspaces'
import { installId, setActiveClusterCache, type ClusterCache, type PodInfo } from '#drivers/k8s/substrate'

const PROJECT = '3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c'
const CREATED = '2026-06-01T00:00:00Z'

function labels(workspaceId: string): Record<string, string> {
  return {
    'yaac.workspace-id': workspaceId,
    'yaac.project-id': PROJECT,
    'yaac.tool': 'claude',
    'yaac.install-id': installId(),
  }
}

/** A workspace's Job, and (unless it is a stray) its running pod. */
function seedWorkspace(workspaceId: string, opts: { pod?: boolean } = {}): void {
  const jobName = `yaac-demo-${workspaceId}`
  fakeCluster.seed({
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: jobName, namespace: 'test-ns', labels: labels(workspaceId), creationTimestamp: CREATED },
  })
  if (opts.pod === false) return
  fakeCluster.seed({
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      name: `${jobName}-x1`, namespace: 'test-ns', creationTimestamp: CREATED,
      labels: { ...labels(workspaceId), 'batch.kubernetes.io/job-name': jobName },
    },
    status: { phase: 'Running' },
  })
}

/** A ClusterCache whose informers are all healthy, as the server publishes. */
function healthyCache(): ClusterCache {
  return {
    healthy: () => true,
    workspacePods: (): PodInfo[] => [{
      podName: 'cached', workspaceId: 'cached', jobName: 'yaac-demo-cached', projectId: PROJECT, tool: 'claude',
      phase: 'Running', running: true, terminating: false, createdAtMs: 1, labels: {},
    }],
    workspaceJobs: () => [],
  } as unknown as ClusterCache
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  seedWorkspace('live')
  seedWorkspace('stray', { pod: false })
})

afterEach(() => {
  setActiveClusterCache(null)
  vi.unstubAllEnvs()
})

describe('createRuntimeSnapshot', () => {
  it('answers workspaces and stray units from one lazy, memoized listing per kind', async () => {
    const snap = createRuntimeSnapshot(false)
    // Creating a snapshot lists nothing.
    expect(fakeCluster.calls).toEqual([])
    expect(snap.resync).toBe(false)
    expect(createRuntimeSnapshot().resync).toBe(true)

    expect((await snap.workspaces()).map((w) => w.workspaceId)).toEqual(['live'])
    // A Job whose pod is gone is a stray unit; one with a live pod is not.
    expect(await snap.strayUnits()).toEqual([{
      workspaceId: 'stray', unitName: 'yaac-demo-stray', projectId: PROJECT, createdAtMs: Date.parse(CREATED), prewarmed: false,
    }])
    await snap.workspaces()
    await snap.strayUnits()
    expect(fakeCluster.callsOf('list')).toHaveLength(2)
    // Each fallback is scoped install-wide by install id.
    expect(fakeCluster.callsOf('list', 'Pod')[0]).toMatchObject({
      namespace: 'test-ns',
      labelSelector: expect.stringMatching(/^yaac\.install-id=test-install,yaac\.workspace-id$/) as unknown,
    })

    // A new snapshot is a new point in time.
    await createRuntimeSnapshot().workspaces()
    expect(fakeCluster.callsOf('list', 'Pod')).toHaveLength(2)
  })

  // Destructive callers must not mistake a failed listing for an empty one.
  it('rejects rather than resolving empty when a listing fails, for the whole snapshot', async () => {
    fakeCluster.intercept((c) => { if (c.kind === 'Job') throw apiError(403, 'forbidden') })
    const snap = createRuntimeSnapshot()
    await expect(snap.strayUnits()).rejects.toThrow('403')
    await expect(snap.strayUnits()).rejects.toThrow('403')
    expect(fakeCluster.callsOf('list', 'Job')).toHaveLength(1)
  })

  it('answers from a healthy active cluster cache, and lists live when it is unhealthy', async () => {
    const cache = healthyCache()
    setActiveClusterCache(cache)
    expect((await createRuntimeSnapshot().workspaces()).map((w) => w.workspaceId)).toEqual(['cached'])
    expect(fakeCluster.calls).toEqual([])

    // A degraded watch must never read as "the object is gone".
    vi.spyOn(cache, 'healthy').mockReturnValue(false)
    expect((await createRuntimeSnapshot().workspaces()).map((w) => w.workspaceId)).toEqual(['live'])
  })
})
