import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('#platform/k8s/client', () => ({
  getCoreApi: vi.fn(() => ({
    listNamespacedPod: vi.fn(() => Promise.resolve({ items: [] })),
    listNamespacedService: vi.fn(() => Promise.resolve({ items: [] })),
    listNamespace: vi.fn(() => Promise.resolve({ items: [] })),
  })),
  getBatchApi: vi.fn(() => ({
    listNamespacedJob: vi.fn(() => Promise.resolve({ items: [] })),
  })),
}))

import {
  ClusterCache,
  getActiveClusterCache,
  setActiveClusterCache,
  type DeltaSource,
} from '#platform/k8s/cluster-cache'
import type { InformerLike } from '#platform/k8s/informer-cache'
import { k8sNamespace } from '#platform/k8s/kubectl'
import { JOB_NAME_LABEL, LABEL_PROJECT, LABEL_SESSION_ID, LABEL_TOOL } from '#platform/k8s/pods'

class FakeInformer implements InformerLike {
  startCalls = 0
  stopCalls = 0
  private readonly handlers = new Map<string, Array<(arg?: unknown) => void>>()

  // Cast: InformerLike['on'] is overloaded per verb; the fake stores every
  // handler uniformly and replays them via emit().
  on = ((verb: string, cb: (arg?: unknown) => void): void => {
    const list = this.handlers.get(verb) ?? []
    list.push(cb)
    this.handlers.set(verb, list)
  }) as InformerLike['on']

  start(): Promise<void> {
    this.startCalls += 1
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.stopCalls += 1
    return Promise.resolve()
  }

  emit(verb: string, arg?: unknown): void {
    for (const cb of this.handlers.get(verb) ?? []) cb(arg)
  }
}

function rawPod(name: string, project = 'proj'): unknown {
  return {
    metadata: {
      name,
      labels: {
        [JOB_NAME_LABEL]: `yaac-${project}-${name}`,
        [LABEL_SESSION_ID]: `sid-${name}`,
        [LABEL_PROJECT]: project,
        [LABEL_TOOL]: 'claude',
      },
      creationTimestamp: '2026-07-21T00:00:00Z',
    },
    status: { phase: 'Running' },
  }
}

const rawVclusterNs = {
  metadata: {
    name: 'yvc-ns1',
    labels: { 'yaac.vcluster': 'yvc-abc', 'yaac.vcluster-session-id': 'sid-1' },
    creationTimestamp: '2026-07-21T00:00:00Z',
  },
}

function makeCache(): {
  cache: ClusterCache
  informers: Map<string, { informer: FakeInformer; selector?: string }>
  deltas: DeltaSource[]
} {
  const informers = new Map<string, { informer: FakeInformer; selector?: string }>()
  const cache = new ClusterCache({
    makeInformerFn: (path, _listFn, labelSelector) => {
      const informer = new FakeInformer()
      informers.set(path, { informer, ...(labelSelector !== undefined ? { selector: labelSelector } : {}) })
      return informer
    },
    relistIntervalMs: 3_600_000,
    log: () => {},
  })
  const deltas: DeltaSource[] = []
  cache.onDelta((source) => deltas.push(source))
  return { cache, informers, deltas }
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

afterEach(() => {
  setActiveClusterCache(null)
})

describe('ClusterCache', () => {
  const ns = k8sNamespace()

  it('starts the three install-scoped informers with their selectors', async () => {
    const { cache, informers } = makeCache()
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)
    const jobs = informers.get(`/apis/batch/v1/namespaces/${ns}/jobs`)
    const namespaces = informers.get('/api/v1/namespaces')
    expect(pods?.informer.startCalls).toBe(1)
    expect(pods?.selector).toContain('yaac.session-id')
    expect(jobs?.informer.startCalls).toBe(1)
    expect(jobs?.selector).toContain('yaac.data-dir-hash')
    expect(namespaces?.informer.startCalls).toBe(1)
    expect(namespaces?.selector).toContain('yaac.vcluster')
    cache.stop()
  })

  it('maps session-pod deltas into the cache and emits the source', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer
    pods.emit('add', rawPod('p1', 'alpha'))
    pods.emit('add', rawPod('p2', 'beta'))
    expect(deltas.filter((d) => d === 'session-pods')).toHaveLength(2)
    expect(cache.sessionPods().map((p) => p.podName).sort()).toEqual(['p1', 'p2'])
    expect(cache.sessionPods('alpha').map((p) => p.podName)).toEqual(['p1'])
    cache.stop()
  })

  it('creates and tears down per-vcluster-namespace informers', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const namespaces = informers.get('/api/v1/namespaces')!.informer

    namespaces.emit('add', rawVclusterNs)
    const vcPods = informers.get('/api/v1/namespaces/yvc-ns1/pods')
    const vcServices = informers.get('/api/v1/namespaces/yvc-ns1/services')
    expect(vcPods?.informer.startCalls).toBe(1)
    expect(vcPods?.selector).toBeUndefined()
    expect(vcServices?.informer.startCalls).toBe(1)
    expect(vcServices?.selector).toBe('vcluster.loft.sh/managed-by=yvc-abc')
    expect(deltas).toContain('vcluster-namespaces')

    namespaces.emit('delete', rawVclusterNs)
    expect(vcPods?.informer.stopCalls).toBe(1)
    expect(vcServices?.informer.stopCalls).toBe(1)
    expect(cache.vclusterPods('yvc-ns1')).toBeNull()
    cache.stop()
  })

  it('serves vcluster pods/services only from a healthy informer', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    informers.get('/api/v1/namespaces')!.informer.emit('add', rawVclusterNs)
    await flush() // let the dynamic caches seed from their (empty) lists
    const vcPods = informers.get('/api/v1/namespaces/yvc-ns1/pods')!.informer

    // Seeded but not yet connected → unhealthy → callers must list live.
    expect(cache.vclusterPods('yvc-ns1')).toBeNull()
    vcPods.emit('connect')
    vcPods.emit('add', { metadata: { name: 'syncer-0' }, status: { podIP: '10.1.2.3' } })
    expect(deltas).toContain('vcluster-pods')
    expect(cache.vclusterPods('yvc-ns1')).toEqual([{ name: 'syncer-0', podIP: '10.1.2.3' }])
    cache.stop()
  })

  it('healthy() tracks the underlying informer state', async () => {
    const { cache, informers } = makeCache()
    cache.start()
    await flush() // seeds all three from their (empty) lists
    expect(cache.healthy('session-pods')).toBe(false)
    informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer.emit('connect')
    expect(cache.healthy('session-pods')).toBe(true)
    expect(cache.healthy('session-jobs')).toBe(false)
    cache.stop()
    expect(cache.healthy('session-pods')).toBe(false)
  })

  it('isolates a throwing delta listener', async () => {
    const { cache, informers } = makeCache()
    cache.onDelta(() => { throw new Error('boom') })
    const seen: DeltaSource[] = []
    cache.onDelta((s) => seen.push(s))
    cache.start()
    await flush()
    informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer.emit('add', rawPod('p1'))
    expect(seen).toContain('session-pods')
    cache.stop()
  })

  it('active-cache singleton set/get round-trips', () => {
    expect(getActiveClusterCache()).toBeNull()
    const { cache } = makeCache()
    setActiveClusterCache(cache)
    expect(getActiveClusterCache()).toBe(cache)
    setActiveClusterCache(null)
    expect(getActiveClusterCache()).toBeNull()
  })
})
