import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as clientNode from '@kubernetes/client-node'
import type { KubernetesListObject, KubernetesObject } from '@kubernetes/client-node'

/**
 * Only the @kubernetes/client-node list calls are faked. KubeConfig is real
 * (loaded from a temp kubeconfig), so the client singletons, informer
 * supervision and object mappers all run for real.
 */
type ListMock = ReturnType<typeof vi.fn<
  (opts?: { namespace?: string; labelSelector?: string }) => Promise<KubernetesListObject<KubernetesObject>>
>>
const emptyList = (): Promise<KubernetesListObject<KubernetesObject>> =>
  Promise.resolve({ items: [] } as unknown as KubernetesListObject<KubernetesObject>)
const listNamespacedPodMock: ListMock = vi.fn(emptyList)
const listNamespacedServiceMock: ListMock = vi.fn(emptyList)
const listNamespacedConfigMapMock: ListMock = vi.fn(emptyList)
const listNamespacedSecretMock: ListMock = vi.fn(emptyList)
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
      listNamespacedSecret = listNamespacedSecretMock
      listNamespace = listNamespaceMock
    },
    BatchV1Api: class {
      listNamespacedJob = listNamespacedJobMock
    },
  }
})

// The live-list fallback's process boundary.
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  kubectlGetJson: vi.fn(),
}))

import {
  ClusterCache,
  LABEL_PROJECT,
  LABEL_TOOL,
  getActiveClusterCache,
  k8sNamespace,
  readWorkspaceJobs,
  readWorkspacePods,
  setActiveClusterCache,
  workspaceIdLabels,
  type PodInfo,
} from '#drivers/k8s/substrate'
import { kubectlGetJson } from '#drivers/k8s/substrate/kubectl'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'
// Setup values and a reset hook, not units under test.
import { _resetK8sClientForTests } from '#drivers/k8s/substrate/client'
import type { DeltaSource } from '#drivers/k8s/substrate/cluster-cache'
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

  // Cast: InformerLike['on'] is overloaded per verb; the fake stores all
  // handlers the same way and replays them via emit().
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
        ...workspaceIdLabels(`sid-${name}`),
        [LABEL_PROJECT]: project,
        'yaac.project-id': `id-${project}`,
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
  listNamespacedSecretMock.mockImplementation(emptyList)
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
    // Lists return Date timestamps; watches return ISO strings. Both must map.
    const created = new Date('2026-07-21T00:00:00Z')
    listNamespacedPodMock.mockImplementation(() => {
      const raw = rawPod('p1', 'alpha') as { metadata: { creationTimestamp: unknown } }
      raw.metadata.creationTimestamp = created
      return listOf(raw)
    })
    listNamespacedJobMock.mockImplementation(() => listOf({
      metadata: {
        name: 'yaac-alpha-p1',
        labels: { ...workspaceIdLabels('sid-p1'), [LABEL_PROJECT]: 'alpha' },
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
    expect(pods?.selector).toContain('yaac.workspace-id')
    expect(jobs?.informer.startCalls).toBe(1)
    expect(jobs?.selector).toContain('yaac.data-dir-hash')

    // The initial list uses the shared API clients, scoped to the install
    // namespace with the watch's selector.
    expect(listNamespacedPodMock).toHaveBeenCalledWith({
      namespace: ns,
      labelSelector: pods?.selector,
    })
    expect(listNamespacedJobMock).toHaveBeenCalledWith({
      namespace: ns,
      labelSelector: jobs?.selector,
    })
    expect(cache.workspacePods()).toEqual([expect.objectContaining({
      podName: 'p1', createdAtMs: created.getTime(),
    })])
    expect(cache.workspaceJobs()).toEqual([{
      jobName: 'yaac-alpha-p1', workspaceId: 'sid-p1', projectSlug: 'alpha',
      createdAtMs: created.getTime(),
    }])
    cache.stop()
  })

  it('watches the proxy’s two outputs and maps them into records and rotations', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const state = informers.get(`/api/v1/namespaces/${ns}/configmaps`)
    const refreshed = informers.get(`/api/v1/namespaces/${ns}/secrets`)
    // Each object is found by its output label, not its name.
    expect(state?.selector).toBe('app=yaac-proxy,yaac.proxy-output=state')
    expect(refreshed?.selector).toBe('app=yaac-proxy,yaac.proxy-output=refreshed')
    expect(listNamespacedConfigMapMock).toHaveBeenCalledWith({ namespace: ns, labelSelector: state?.selector })
    expect(listNamespacedSecretMock).toHaveBeenCalledWith({ namespace: ns, labelSelector: refreshed?.selector })
    expect(cache.proxyRecords()).toEqual({ blockedHosts: {}, gitAuthFailures: {} })
    expect(cache.refreshedCredentials()).toEqual({})

    state!.informer.emit('update', {
      metadata: { name: 'yaac-proxy-state', labels: { 'yaac.proxy-output': 'state' } },
      data: {
        'blocked-hosts.json': JSON.stringify({ w1: ['evil.example.com', 3] }),
        'git-auth-failures.json': JSON.stringify({ demo: [{ host: 'github.com', status: 401, atMs: 1 }, { bad: true }] }),
      },
    })
    expect(cache.proxyRecords()).toEqual({
      blockedHosts: { w1: ['evil.example.com'] },
      gitAuthFailures: { demo: [{ host: 'github.com', status: 401, atMs: 1 }] },
    })
    expect(deltas).toContain('proxy-state')

    const claude = { accessToken: 'a2', refreshToken: 'r2', expiresAt: 5, scopes: ['user:inference'] }
    const file = { kind: 'oauth', savedAt: 'x', claudeAiOauth: claude }
    refreshed!.informer.emit('add', {
      metadata: { name: 'yaac-proxy-refreshed', labels: { 'yaac.proxy-output': 'refreshed' } },
      data: {
        'claude.json': Buffer.from(JSON.stringify(file)).toString('base64'),
        // A malformed entry is dropped.
        'codex.json': Buffer.from('{"kind":"oauth","codexOauth":{}}').toString('base64'),
      },
    })
    expect(cache.refreshedCredentials()).toEqual({ claude })
    expect(deltas).toContain('proxy-refreshed')
    // An object without the label is ignored.
    refreshed!.informer.emit('add', { metadata: { name: 'yaac-proxy-auth' }, data: {} })
    expect(cache.refreshedCredentials()).toEqual({ claude })
    cache.stop()
  })

  it('skips Job objects it cannot map', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const jobs = informers.get(`/apis/batch/v1/namespaces/${ns}/jobs`)!.informer
    // A Job without workspace labels, or with no shape at all, is ignored.
    jobs.emit('add', { metadata: { name: 'some-other-job', creationTimestamp: '2026-07-21T00:00:00Z' } })
    jobs.emit('add', {})
    expect(cache.workspaceJobs()).toEqual([])
    expect(deltas.filter((d) => d === 'workspace-jobs')).toHaveLength(0)
    cache.stop()
  })

  it('maps session-pod deltas into the cache, emits the source, and skips unmappable rows', async () => {
    const { cache, informers, deltas } = makeCache()
    cache.start()
    await flush()
    const pods = informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer
    pods.emit('add', rawPod('p1', 'alpha'))
    pods.emit('add', rawPod('p2', 'beta'))
    // A pod with no yaac labels is ignored, not fatal.
    pods.emit('add', { metadata: { name: 'kube-proxy' } })
    expect(deltas.filter((d) => d === 'workspace-pods')).toHaveLength(2)
    expect(cache.workspacePods().map((p) => p.podName).sort()).toEqual(['p1', 'p2'])
    expect(cache.workspacePods('alpha').map((p) => p.podName)).toEqual(['p1'])

    // An update that maps to the same row is not a delta; a delete is.
    pods.emit('update', rawPod('p1', 'alpha'))
    expect(deltas.filter((d) => d === 'workspace-pods')).toHaveLength(2)
    pods.emit('delete', rawPod('p1', 'alpha'))
    expect(cache.workspacePods().map((p) => p.podName)).toEqual(['p2'])
    expect(deltas.filter((d) => d === 'workspace-pods')).toHaveLength(3)
    pods.emit('delete', rawPod('ghost'))
    expect(deltas.filter((d) => d === 'workspace-pods')).toHaveLength(3)
    cache.stop()
  })

  it('healthy() tracks the underlying informer state', async () => {
    const { cache, informers } = makeCache()
    cache.start()
    await flush() // seeds both from their (empty) lists
    expect(cache.healthy('workspace-pods')).toBe(false)
    informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer.emit('connect')
    expect(cache.healthy('workspace-pods')).toBe(true)
    expect(cache.healthy('workspace-jobs')).toBe(false)
    informers.get(`/apis/batch/v1/namespaces/${ns}/jobs`)!.informer.emit('connect')
    expect(cache.healthy('workspace-jobs')).toBe(true)
    cache.stop()
    expect(cache.healthy('workspace-pods')).toBe(false)
  })

  it('isolates a throwing delta listener', async () => {
    const { cache, informers, log } = makeCache()
    cache.onDelta(() => { throw new Error('boom') })
    const seen: DeltaSource[] = []
    cache.onDelta((s) => seen.push(s))
    cache.start()
    await flush()
    informers.get(`/api/v1/namespaces/${ns}/pods`)!.informer.emit('add', rawPod('p1'))
    expect(seen).toContain('workspace-pods')
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
    expect(cache.healthy('workspace-pods')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(2)

    // A quick second failure doubles the delay.
    pods.emit('error', new Error('watch died again'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pods.startCalls).toBe(3)

    // After 60s or more of uptime, the delay resets to the base.
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
    expect(cache.workspacePods().map((p) => p.podName)).toEqual(['p1'])

    // A missed DELETE and ADD: the next relist replaces the whole set.
    listNamespacedPodMock.mockImplementation(() => listOf(rawPod('p2')))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cache.workspacePods().map((p) => p.podName)).toEqual(['p2'])
    expect(deltas.filter((d) => d === 'workspace-pods')).toHaveLength(2)

    // A failed relist keeps the current set and retries later.
    listNamespacedPodMock.mockImplementation(() => Promise.reject(new Error('apiserver down')))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cache.workspacePods().map((p) => p.podName)).toEqual(['p2'])
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

/** A published cache whose informers report `healthy`. */
function stubCache(healthy: boolean): ClusterCache {
  return {
    healthy: () => healthy,
    workspacePods: (project?: string) => [{ podName: `cached-${project ?? 'all'}` } as PodInfo],
    workspaceJobs: () => [{ jobName: 'cached-job' }],
  } as unknown as ClusterCache
}

describe('readWorkspacePods', () => {
  it('answers from a healthy cache, scoped to the project, without listing', async () => {
    setActiveClusterCache(stubCache(true))
    expect((await readWorkspacePods('demo')).map((p) => p.podName)).toEqual(['cached-demo'])
    expect(vi.mocked(kubectlGetJson)).not.toHaveBeenCalled()
  })

  // Unseeded, a cache reads as an empty cluster; with a dropped watch, a
  // stale one.
  it.each([['no cache', null], ['an unhealthy cache', stubCache(false)]])(
    'lists live past %s', async (_case, cache) => {
      setActiveClusterCache(cache)
      vi.mocked(kubectlGetJson).mockResolvedValue({ items: [] })
      await expect(readWorkspacePods('demo')).resolves.toEqual([])
      expect(vi.mocked(kubectlGetJson).mock.calls[0][0].join(' ')).toMatch(/^get pods .*yaac\.project=demo$/)
    },
  )
})

describe('readWorkspaceJobs', () => {
  it('answers from a healthy cache, and lists live past an unhealthy one', async () => {
    setActiveClusterCache(stubCache(true))
    expect((await readWorkspaceJobs()).map((j) => j.jobName)).toEqual(['cached-job'])
    expect(vi.mocked(kubectlGetJson)).not.toHaveBeenCalled()

    setActiveClusterCache(stubCache(false))
    vi.mocked(kubectlGetJson).mockResolvedValue({ items: [] })
    await expect(readWorkspaceJobs()).resolves.toEqual([])
    expect(vi.mocked(kubectlGetJson).mock.calls[0][0].slice(0, 2)).toEqual(['get', 'jobs'])
  })
})
