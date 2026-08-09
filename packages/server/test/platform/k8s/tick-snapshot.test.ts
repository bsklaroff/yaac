import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The fallback listings are one-shot kubectl calls, so the child process is
// the boundary: the session-pod and vcluster object layers (their selectors,
// schemas and mappers) run for real behind it.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: readonly string[], opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
    return { stdin: { end: vi.fn() } }
  },
  exec: vi.fn(),
}))

import {
  createTickSnapshot,
  setActiveClusterCache,
  type ClusterCache,
  type PodInfo,
  type VclusterPod,
} from '#platform/k8s'

const VC = { namespace: 'test-ns-vc-abcd1234', name: 'yvc-abcd1234' }
const SID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'

/** Raw kubectl payloads, keyed by the resource in the argv. */
const payloads: Record<string, unknown> = {}

function rawPod(name: string): unknown {
  return {
    metadata: {
      name,
      labels: {
        'batch.kubernetes.io/job-name': `yaac-demo-${SID}`,
        'yaac.session-id': SID,
        'yaac.project': 'demo',
        'yaac.tool': 'claude',
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
    worktreePods: () => [{ podName: 'cached' } as PodInfo],
    worktreeJobs: () => [],
    vclusterNamespaces: () => [],
    vclusterPods: () => [{ name: 'vp', podIP: '10.0.0.9', labels: {} }],
    vclusterServices: () => [{ name: 'yaac-proxy', labels: {} }],
    vclusterConfigMaps: () => [{ name: 'yaac-redirect-claim-x-yaac-x-vc', data: {} }],
  } as unknown as ClusterCache
}

/** kubectl argv → the resource it lists (`get <kind> -n <ns> …`). */
const kindOf = (args: readonly string[]): string => args[1]

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  execFileMock.mockReset()
  execFileMock.mockImplementation((_file, args) =>
    Promise.resolve({ stdout: JSON.stringify(payloads[kindOf(args)] ?? { items: [] }), stderr: '' }))
  payloads['pods'] = { items: [rawPod('yaac-demo-p1')] }
  payloads['jobs'] = { items: [] }
  payloads['namespaces'] = { items: [] }
  payloads['services'] = { items: [] }
  payloads['configmaps'] = { items: [] }
})

afterEach(() => {
  setActiveClusterCache(null)
  vi.unstubAllEnvs()
})

describe('createTickSnapshot', () => {
  it('is lazy — creating a snapshot lists nothing', () => {
    createTickSnapshot()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('defaults to resync=true for direct invocations', () => {
    expect(createTickSnapshot().resync).toBe(true)
    expect(createTickSnapshot(false).resync).toBe(false)
  })

  it('lists each kind at most once per snapshot and maps the rows', async () => {
    const snap = createTickSnapshot()
    const pods = await snap.pods()
    expect(pods.map((p) => p.podName)).toEqual(['yaac-demo-p1'])
    expect(pods[0].worktreeId).toBe(SID)
    expect(await snap.pods()).toBe(pods)
    await snap.jobs()
    await snap.jobs()
    await snap.vclusters()
    await snap.vclusters()
    await snap.vclusterPods(VC.namespace)
    await snap.vclusterPods(VC.namespace)
    await snap.vclusterServices(VC)
    await snap.vclusterServices(VC)
    await snap.vclusterConfigMaps(VC.namespace)
    await snap.vclusterConfigMaps(VC.namespace)
    expect(execFileMock).toHaveBeenCalledTimes(6)
    // Each fallback is scoped the way its own object layer scopes it: the
    // install-wide lists by data-dir-hash, the vcluster ones by namespace.
    const argv = execFileMock.mock.calls.map(([, args]) => args.join(' '))
    expect(argv.find((c) => c.startsWith('get pods -n test-ns')))
      .toMatch(/-l yaac\.data-dir-hash=[0-9a-f]{16},yaac\.session-id/)
    expect(argv).toContain(`get pods -n ${VC.namespace} -o json`)
    expect(argv).toContain(`get services -n ${VC.namespace} -l vcluster.loft.sh/managed-by=${VC.name} -o json`)
    expect(argv).toContain(`get configmaps -n ${VC.namespace} -o json`)
  })

  it('maps the vcluster object layer, dropping rows it cannot map', async () => {
    payloads['namespaces'] = {
      items: [
        {
          metadata: {
            name: VC.namespace,
            creationTimestamp: '2026-06-15T00:00:00Z',
            labels: {
              'yaac.vcluster': VC.name,
              'yaac.vcluster-session-id': SID,
              'yaac.vcluster-data-dir-hash': 'ddh16',
            },
          },
        },
        // Not a yaac vcluster (no ownership labels) → skipped, not fatal.
        { metadata: { name: 'kube-system', creationTimestamp: '', labels: {} } },
      ],
    }
    payloads['pods'] = {
      items: [
        { metadata: { name: 'syncer-0' }, status: { podIP: '10.1.2.3' } },
        { metadata: { name: 'pending-0' } }, // no IP yet — still a row
        {}, // malformed → dropped
      ],
    }
    payloads['services'] = {
      items: [{ metadata: { name: 'yaac-proxy-x-yaac-x-yvc', labels: { 'yaac.role': 'inner-proxy' } } }, {}],
    }
    payloads['configmaps'] = {
      items: [{ metadata: { name: 'claims' }, data: { claims: 'a,b' } }, { metadata: {} }],
    }

    const snap = createTickSnapshot()
    expect(await snap.vclusters()).toEqual([{
      name: VC.name, worktreeId: SID, namespace: VC.namespace,
      creationTimestamp: '2026-06-15T00:00:00Z',
    }])
    expect(await snap.vclusterPods(VC.namespace)).toEqual([
      { name: 'syncer-0', podIP: '10.1.2.3', labels: {} },
      { name: 'pending-0', labels: {} },
    ])
    expect(await snap.vclusterServices(VC))
      .toEqual([{ name: 'yaac-proxy-x-yaac-x-yvc', labels: { 'yaac.role': 'inner-proxy' } }])
    expect(await snap.vclusterConfigMaps(VC.namespace))
      .toEqual([{ name: 'claims', data: { claims: 'a,b' } }])
  })

  it('memoizes vcluster getters per namespace, not globally', async () => {
    const snap = createTickSnapshot()
    await snap.vclusterPods('ns-a')
    await snap.vclusterPods('ns-b')
    const argv = execFileMock.mock.calls.map(([, args]) => args.join(' '))
    expect(argv).toContain('get pods -n ns-a -o json')
    expect(argv).toContain('get pods -n ns-b -o json')
  })

  it('separate snapshots list independently', async () => {
    await createTickSnapshot().pods()
    await createTickSnapshot().pods()
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('reads an absent namespace as empty rather than an error', async () => {
    // A vcluster torn down mid-pass: kubectl 404s, the object layer returns
    // no rows, and the step sees an empty namespace instead of throwing.
    execFileMock.mockRejectedValue(
      Object.assign(new Error('kubectl failed'), { stderr: 'Error from server (NotFound)' }),
    )
    const snap = createTickSnapshot()
    expect(await snap.vclusterPods(VC.namespace)).toEqual([])
    expect(await snap.vclusterServices(VC)).toEqual([])
    expect(await snap.vclusterConfigMaps(VC.namespace)).toEqual([])
    expect(await snap.vclusters()).toEqual([])
    expect(await snap.pods()).toEqual([])
    expect(await snap.jobs()).toEqual([])
  })

  it('a failed listing stays failed for the whole snapshot (no per-consumer retry)', async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error('kubectl failed'), { stderr: 'forbidden' }))
    const snap = createTickSnapshot()
    await expect(snap.pods()).rejects.toThrow('kubectl failed')
    await expect(snap.pods()).rejects.toThrow('kubectl failed')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('answers from a healthy active cluster cache without listing', async () => {
    setActiveClusterCache(healthyCache())
    const snap = createTickSnapshot()
    expect((await snap.pods()).map((p) => p.podName)).toEqual(['cached'])
    expect(await snap.vclusterPods(VC.namespace))
      .toEqual([{ name: 'vp', podIP: '10.0.0.9', labels: {} } as VclusterPod])
    expect(await snap.vclusterServices(VC)).toEqual([{ name: 'yaac-proxy', labels: {} }])
    expect(await snap.vclusterConfigMaps(VC.namespace))
      .toEqual([{ name: 'yaac-redirect-claim-x-yaac-x-vc', data: {} }])
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('falls back to a live list when the cache source is unhealthy', async () => {
    // The destructive-step safety story: a degraded watch must never be
    // mistaken for "this object no longer exists".
    const cache = healthyCache()
    vi.spyOn(cache, 'healthy').mockReturnValue(false)
    vi.spyOn(cache, 'vclusterPods').mockReturnValue(null)
    vi.spyOn(cache, 'vclusterServices').mockReturnValue(null)
    vi.spyOn(cache, 'vclusterConfigMaps').mockReturnValue(null)
    setActiveClusterCache(cache)
    const snap = createTickSnapshot()
    expect((await snap.pods()).map((p) => p.podName)).toEqual(['yaac-demo-p1'])
    await snap.jobs()
    await snap.vclusters()
    await snap.vclusterPods(VC.namespace)
    await snap.vclusterServices(VC)
    await snap.vclusterConfigMaps(VC.namespace)
    expect(execFileMock).toHaveBeenCalledTimes(6)
  })
})
