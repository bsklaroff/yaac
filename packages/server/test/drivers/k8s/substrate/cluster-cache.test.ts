import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as clientNode from '@kubernetes/client-node'
import type { KubernetesListObject, KubernetesObject } from '@kubernetes/client-node'

/**
 * The registry's boundary is @kubernetes/client-node: its API classes are
 * what speak HTTP to the apiserver. Faking the list calls (and leaving
 * KubeConfig real, loaded from a temp kubeconfig) runs the client
 * singletons, the informer supervision and every object mapper for real —
 * only the wire is fake.
 */
type ListMock = ReturnType<typeof vi.fn<
  (opts?: { namespace?: string; labelSelector?: string }) => Promise<KubernetesListObject<KubernetesObject>>
>>
const emptyList = (): Promise<KubernetesListObject<KubernetesObject>> =>
  Promise.resolve({ items: [] } as unknown as KubernetesListObject<KubernetesObject>)
const listNamespacedPodMock: ListMock = vi.fn(emptyList)
const listNamespacedServiceMock: ListMock = vi.fn(emptyList)
const listNamespacedConfigMapMock: ListMock = vi.fn(emptyList)
const listNamespaceMock: ListMock = vi.fn(emptyList)
const listNamespacedJobMock: ListMock = vi.fn(emptyList)

vi.mock('@kubernetes/client-node', async (importOriginal) => {
  const actual = await importOriginal<typeof clientNode>()
  return {
    ...actual,
    CoreV1Api: class {
      listNamespacedPod = listNamespacedPodMock
      listNamespacedService = listNamespacedServiceMock
      listNamespacedConfigMap = listNamespacedConfigMapMock
      listNamespace = listNamespaceMock
    },
    BatchV1Api: class {
      listNamespacedJob = listNamespacedJobMock
    },
  }
})

import {
  ClusterCache,
  LABEL_PROJECT,
  LABEL_TOOL,
  getActiveClusterCache,
  k8sNamespace,
  setActiveClusterCache,
  worktreeIdLabels,
  type DeltaSource,
} from '#drivers/k8s/substrate'
// Internals, for setup only: the client reset hook, the informer surface the
// fake implements, and the job-name label the raw pod fixtures carry.
import { _resetK8sClientForTests } from '#drivers/k8s/substrate/client'
import type { InformerLike } from '#drivers/k8s/substrate/informer-cache'
import { JOB_NAME_LABEL } from '#drivers/k8s/substrate/pods'

const KUBECONFIG_YAML = `apiVersion: v1
kind: Config
clusters:
- name: test-cluster
  cluster:
    server: https://127.0.0.1:1
users:
- name: test-user
  user: {}
contexts:
- name: test-context
  context:
    cluster: test-cluster
    user: test-user
current-context: test-context
`

/** Fake client-node informer: records lifecycle calls, replays events. */
class FakeInformer implements InformerLike {
  startCalls = 0
  stopCalls = 0
  startImpl: () => Promise<void> = () => Promise.resolve()
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
    return this.startImpl()
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
        ...worktreeIdLabels(`sid-${name}`),
        [LABEL_PROJECT]: project,
        [LABEL_TOOL]: 'claude',
      },
      creationTimestamp: '2026-07-21T00:00:00Z',
    },
    status: { phase: 'Running' },
  }
}

const listOf = (...items: unknown[]): Promise<KubernetesListObject<KubernetesObject>> =>
  Promise.resolve({ items } as unknown as KubernetesListObject<KubernetesObject>)

function makeCache(deps: { relistIntervalMs?: number; restartDelayMs?: number } = {}): {
  cache: ClusterCache
  informers: Map<string, { informer: FakeInformer; selector?: string }>
  deltas: DeltaSource[]
  log: string[]
} {
  const informers = new Map<string, { informer: FakeInformer; selector?: string }>()
  const log: string[] = []
  const cache = new ClusterCache({
    makeInformerFn: (p, _listFn, labelSelector) => {
      const informer = new FakeInformer()
      informers.set(p, { informer, ...(labelSelector !== undefined ? { selector: labelSelector } : {}) })
      return informer
    },
    relistIntervalMs: deps.relistIntervalMs ?? 3_600_000,
    log: (msg) => log.push(msg),
  })
  const deltas: DeltaSource[] = []
  cache.onDelta((source) => deltas.push(source))
  return { cache, informers, deltas, log }
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  listNamespacedPodMock.mockImplementation(emptyList)
  listNamespacedServiceMock.mockImplementation(emptyList)
  listNamespacedConfigMapMock.mockImplementation(emptyList)
  listNamespaceMock.mockImplementation(emptyList)
  listNamespacedJobMock.mockImplementation(emptyList)
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-cluster-cache-'))
  const file = path.join(tmpDir, 'config')
  await fs.writeFile(file, KUBECONFIG_YAML)
  vi.stubEnv('KUBECONFIG', file)
  _resetK8sClientForTests()
})

afterEach(async () => {
  setActiveClusterCache(null)
  _resetK8sClientForTests()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ClusterCache', () => {
  const ns = k8sNamespace()

  it('starts the two install-scoped informers and seeds them off the typed client', async () => {
    // The list path yields deserialized class instances — Date timestamps,
    // where the watch path delivers ISO strings. Both must map.
    const created = new Date('2026-07-21T00:00:00Z')
    listNamespacedPodMock.mockImplementation(() => {
      const raw = rawPod('p1', 'alpha') as { metadata: { creationTimestamp: unknown } }
      raw.metadata.creationTimestamp = created
      return listOf(raw)
    })
    listNamespacedJobMock.mockImplementation(() => listOf({
      metadata: {
        name: 'yaac-alpha-p1',
        labels: { ...worktreeIdLabels('sid-p1'), [LABEL_PROJECT]: 'alpha' },
        creationTimestamp: created,
      },
      status: {},
    }))
    const { cache, informers } = makeCache()
    cache.start()
    await flush()

    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)
    const jobs = informers.get(`/apis/batch/v1/namespaces/${ns}/jobs`)
    expect(pods?.informer.startCalls).toBe(1)
    expect(pods?.selector).toContain('yaac.worktree-id')
    expect(jobs?.informer.startCalls).toBe(1)
    expect(jobs?.selector).toContain('yaac.data-dir-hash')

    // The seed list goes through the memoized CoreV1Api/BatchV1Api clients,
    // scoped to the install namespace and the same selector as the watch.
    expect(listNamespacedPodMock).toHaveBeenCalledWith({
      namespace: ns,
      labelSelector: pods?.selector,
    })
    expect(listNamespacedJobMock).toHaveBeenCalledWith({
      namespace: ns,
      labelSelector: jobs?.selector,
    })
    expect(cache.worktreePods()).toEqual([expect.objectContaining({
      podName: 'p1', createdAtMs: created.getTime(),
    })])
    expect(cache.worktreeJobs()).toEqual([{
      jobName: 'yaac-alpha-p1', worktreeId: 'sid-p1', projectSlug: 'alpha',
      createdAtMs: created.getTime(),
    }])
    cache.stop()
  })

  it('skips Job objects it cannot map', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const jobs = informers.get(`/apis/batch/v1/namespaces/${ns}/jobs`)!.informer
    // A Job without the session labels is not ours (nor is a shapeless one).
    jobs.emit('add', { metadata: { name: 'some-other-job', creationTimestamp: '2026-07-21T00:00:00Z' } })
    jobs.emit('add', {})
    expect(cache.worktreeJobs()).toEqual([])
    expect(deltas.filter((d) => d === 'worktree-jobs')).toHaveLength(0)
    cache.stop()
  })

  it('maps session-pod deltas into the cache, emits the source, and skips unmappable rows', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer
    pods.emit('add', rawPod('p1', 'alpha'))
    pods.emit('add', rawPod('p2', 'beta'))
    // A pod with no yaac labels is not ours — dropped, not fatal.
    pods.emit('add', { metadata: { name: 'kube-proxy' } })
    expect(deltas.filter((d) => d === 'worktree-pods')).toHaveLength(2)
    expect(cache.worktreePods().map((p) => p.podName).sort()).toEqual(['p1', 'p2'])
    expect(cache.worktreePods('alpha').map((p) => p.podName)).toEqual(['p1'])

    // An update that maps to the identical row is not a delta; a delete is.
    pods.emit('update', rawPod('p1', 'alpha'))
    expect(deltas.filter((d) => d === 'worktree-pods')).toHaveLength(2)
    pods.emit('delete', rawPod('p1', 'alpha'))
    expect(cache.worktreePods().map((p) => p.podName)).toEqual(['p2'])
    expect(deltas.filter((d) => d === 'worktree-pods')).toHaveLength(3)
    // Deleting a row the cache never held is a no-op.
    pods.emit('delete', rawPod('ghost'))
    expect(deltas.filter((d) => d === 'worktree-pods')).toHaveLength(3)
    cache.stop()
  })

  it('healthy() tracks the underlying informer state', async () => {
    const { cache, informers } = makeCache()
    cache.start()
    await flush() // seeds both from their (empty) lists
    expect(cache.healthy('worktree-pods')).toBe(false)
    informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer.emit('connect')
    expect(cache.healthy('worktree-pods')).toBe(true)
    expect(cache.healthy('worktree-jobs')).toBe(false)
    informers.get(`/apis/batch/v1/namespaces/${ns}/jobs`)!.informer.emit('connect')
    expect(cache.healthy('worktree-jobs')).toBe(true)
    cache.stop()
    expect(cache.healthy('worktree-pods')).toBe(false)
  })

  it('isolates a throwing delta listener', async () => {
    const { cache, informers, log } = makeCache()
    cache.onDelta(() => { throw new Error('boom') })
    const seen: DeltaSource[] = []
    cache.onDelta((s) => seen.push(s))
    cache.start()
    await flush()
    informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer.emit('add', rawPod('p1'))
    expect(seen).toContain('worktree-pods')
    expect(log.some((l) => l.includes('listener failed'))).toBe(true)
    cache.stop()
  })

  it('restarts a failed informer with doubling backoff, resetting after a long-lived watch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    const { cache, informers } = makeCache()
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer
    expect(pods.startCalls).toBe(1)

    pods.emit('connect')
    pods.emit('error', new Error('watch died'))
    expect(cache.healthy('worktree-pods')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(2)

    // Rapid second failure → doubled delay.
    pods.emit('error', new Error('watch died again'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(3)

    // A failure after ≥60s of uptime restarts at the base delay again.
    await vi.advanceTimersByTimeAsync(61_000)
    pods.emit('error', new Error('watch died once more'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(4)
    cache.stop()
  })

  it('treats a rejected informer start as an error and restarts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    const informers = new Map<string, FakeInformer>()
    const cache = new ClusterCache({
      makeInformerFn: (p) => {
        const informer = new FakeInformer()
        informer.startImpl = () => Promise.reject(new Error('no cluster'))
        informers.set(p, informer)
        return informer
      },
      relistIntervalMs: 3_600_000,
      log: () => {},
    })
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)!
    pods.startImpl = () => Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(2)
    cache.stop()
  })

  it('relists on the interval, repairing ghost rows, and keeps the cache when a relist fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    listNamespacedPodMock.mockImplementation(() => listOf(rawPod('p1')))
    const { cache, deltas, log } = makeCache({ relistIntervalMs: 60_000 })
    cache.start()
    await flush()
    expect(cache.worktreePods().map((p) => p.podName)).toEqual(['p1'])

    // A missed DELETE + missed ADD: the next relist replaces the whole set.
    listNamespacedPodMock.mockImplementation(() => listOf(rawPod('p2')))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cache.worktreePods().map((p) => p.podName)).toEqual(['p2'])
    expect(deltas.filter((d) => d === 'worktree-pods')).toHaveLength(2)

    // A failed relist is a cluster hiccup: keep what we have, log, retry later.
    listNamespacedPodMock.mockImplementation(() => Promise.reject(new Error('apiserver down')))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cache.worktreePods().map((p) => p.podName)).toEqual(['p2'])
    expect(log.some((l) => l.includes('relist failed'))).toBe(true)
    cache.stop()
  })

  it('stop() halts every informer, its restarts and its relists', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    const { cache, informers } = makeCache({ relistIntervalMs: 60_000 })
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer
    pods.emit('error', new Error('watch died'))
    const listsBeforeStop = listNamespacedPodMock.mock.calls.length
    cache.stop()
    expect(pods.stopCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(pods.startCalls).toBe(1)
    expect(listNamespacedPodMock.mock.calls.length).toBe(listsBeforeStop)
  })
})

describe('setActiveClusterCache', () => {
  it('publishes the registry the display path and reconcile steps read', () => {
    const { cache } = makeCache()
    setActiveClusterCache(cache)
    expect(getActiveClusterCache()).toBe(cache)
    setActiveClusterCache(null)
    expect(getActiveClusterCache()).toBeNull()
  })
})

describe('getActiveClusterCache', () => {
  it('is null outside the server, so callers fall back to one-shot lists', () => {
    expect(getActiveClusterCache()).toBeNull()
  })
})
