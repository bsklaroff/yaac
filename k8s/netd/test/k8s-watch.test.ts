import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as clientNode from '@kubernetes/client-node'
import type { KubernetesObject } from '@kubernetes/client-node'
import { inClusterClient, mapPod, mapService, watchPods, watchServices } from 'yaac-netd/k8s-watch'

/**
 * Fake client-node informer, driven by the test. `ListWatch` is the API
 * boundary, so it is the only thing mocked.
 */
class FakeInformer {
  readonly handlers = new Map<string, Array<(arg?: unknown) => void>>()
  objects: KubernetesObject[] = []
  startCalls = 0
  startResult: () => Promise<void> = () => Promise.resolve()

  constructor(
    readonly path: string,
    readonly listFn: () => Promise<unknown>,
    readonly labelSelector: string | undefined,
  ) {}

  on(verb: string, cb: (arg?: unknown) => void): void {
    this.handlers.set(verb, [...(this.handlers.get(verb) ?? []), cb])
  }

  start(): Promise<void> {
    this.startCalls += 1
    return this.startResult()
  }

  list(): KubernetesObject[] {
    return this.objects
  }

  emit(verb: string, obj?: unknown): void {
    for (const cb of this.handlers.get(verb) ?? []) cb(obj)
  }
}

const informers = vi.hoisted(() => [] as FakeInformer[])
vi.mock('@kubernetes/client-node', async (importOriginal) => ({
  ...(await importOriginal<typeof clientNode>()),
  ListWatch: function (path: string, _watch: unknown, listFn: () => Promise<unknown>, _autoStart: boolean, labelSelector?: string) {
    const informer = new FakeInformer(path, listFn, labelSelector)
    informers.push(informer)
    return informer
  },
}))

/** A client whose list calls record their arguments instead of dialing. */
function fakeClient() {
  const listNamespacedPod = vi.fn(() => Promise.resolve({ items: [] }))
  const listNamespacedService = vi.fn(() => Promise.resolve({ items: [] }))
  const client = {
    kubeConfig: {},
    core: { listNamespacedPod, listNamespacedService },
    namespace: 'yaac',
  } as unknown as Parameters<typeof watchPods>[0]
  return { client, listNamespacedPod, listNamespacedService }
}

describe('mapPod', () => {
  it('maps an API pod to netd\'s shape', () => {
    expect(mapPod({
      metadata: { name: 'p', namespace: 'yaac', labels: { 'yaac.workspace-id': 's1' } },
      status: { podIP: '10.244.0.9' },
    })).toEqual({ name: 'p', namespace: 'yaac', podIp: '10.244.0.9' })
  })

  it('drops a pod with no IP yet — a half-built pod must yield no rules', () => {
    expect(mapPod({ metadata: { name: 'p', namespace: 'n' }, status: {} })).toBeNull()
    expect(mapPod({ metadata: { name: 'p', namespace: 'n' } })).toBeNull()
  })

  it('drops anything without an identity', () => {
    expect(mapPod({ metadata: { namespace: 'n' }, status: { podIP: '1.2.3.4' } })).toBeNull()
    expect(mapPod({ metadata: { name: 'p' }, status: { podIP: '1.2.3.4' } })).toBeNull()
    expect(mapPod({})).toBeNull()
  })
})

describe('mapService', () => {
  it('maps an API Service to netd\'s shape', () => {
    expect(mapService({
      metadata: { name: 'yaac-proxy', namespace: 'yaac' },
      spec: { clusterIP: '10.96.0.50' },
    })).toEqual({ name: 'yaac-proxy', clusterIp: '10.96.0.50' })
  })

  it('drops a Service with no ClusterIP or no name', () => {
    expect(mapService({ metadata: { name: 's' }, spec: {} })).toBeNull()
    expect(mapService({ metadata: {}, spec: { clusterIP: '10.96.0.1' } })).toBeNull()
  })
})

describe('inClusterClient', () => {
  const saved = {
    host: process.env.KUBERNETES_SERVICE_HOST,
    port: process.env.KUBERNETES_SERVICE_PORT,
  }

  afterEach(() => {
    if (saved.host === undefined) delete process.env.KUBERNETES_SERVICE_HOST
    else process.env.KUBERNETES_SERVICE_HOST = saved.host
    if (saved.port === undefined) delete process.env.KUBERNETES_SERVICE_PORT
    else process.env.KUBERNETES_SERVICE_PORT = saved.port
  })

  it('points at the in-cluster apiserver and authenticates from the token FILE', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    const { kubeConfig, namespace } = inClusterClient('yaac')
    expect(namespace).toBe('yaac')
    expect(kubeConfig.getCurrentCluster()?.server).toBe('https://10.96.0.1:443')
    // A tokenFile is re-read, so kubelet's token rotation is picked up.
    const authProvider = kubeConfig.getCurrentUser()?.authProvider as
      { name?: string; config?: { tokenFile?: string } } | undefined
    expect(authProvider?.name).toBe('tokenFile')
    expect(authProvider?.config?.tokenFile).toContain('serviceaccount/token')
  })
})

describe('watchPods', () => {
  let onChange: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ })
    informers.length = 0
    onChange = vi.fn<() => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('watches and lists only this install\'s workspace pods, never the proxy', async () => {
    // Another install's pods, or the proxy itself, must never be
    // redirected here; scoping the watch keeps them out of the store.
    const { client, listNamespacedPod } = fakeClient()
    watchPods(client, onChange)
    const [informer] = informers
    expect(informer.path).toBe('/api/v1/namespaces/yaac/pods')
    expect(informer.labelSelector).toBe('yaac.workspace-id,app!=yaac-proxy')
    // client-node applies the selector to the watch only.
    await informer.listFn()
    expect(listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'yaac', labelSelector: 'yaac.workspace-id,app!=yaac-proxy',
    })
  })

  it('reads through to the store, mapping and dropping unusable pods', () => {
    const pods = watchPods(fakeClient().client, onChange)
    informers[0].objects = [
      { metadata: { name: 'a', namespace: 'yaac' }, status: { podIP: '10.244.0.9' } } as KubernetesObject,
      { metadata: { name: 'half-built', namespace: 'yaac' } },
    ]
    expect(pods()).toEqual([{ name: 'a', namespace: 'yaac', podIp: '10.244.0.9' }])
  })

  it('starts at once and notifies on every delta kind', () => {
    watchPods(fakeClient().client, onChange)
    const [informer] = informers
    expect(informer.startCalls).toBe(1)
    informer.emit('add')
    informer.emit('update')
    informer.emit('delete')
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('restarts with doubling backoff after errors, one restart per burst', () => {
    // client-node's informer stops on any non-410 error.
    watchPods(fakeClient().client, onChange)
    const [informer] = informers
    informer.emit('error', new Error('a'))
    informer.emit('error', new Error('b'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)

    informer.emit('error', new Error('again'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(3)
  })

  it('resets the backoff after a long healthy run', () => {
    watchPods(fakeClient().client, onChange)
    const [informer] = informers
    informer.emit('error', new Error('boom'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
    vi.advanceTimersByTime(120_000)
    informer.emit('error', new Error('dropped'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(3)
  })

  it('treats a start() rejection as an error and retries', async () => {
    watchPods(fakeClient().client, onChange)
    const [informer] = informers
    informer.startResult = () => Promise.reject(new Error('no apiserver'))
    informer.emit('error', new Error('first'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(informer.startCalls).toBe(3)
  })
})

describe('watchServices', () => {
  it('watches every Service in the install namespace', async () => {
    informers.length = 0
    const { client, listNamespacedService } = fakeClient()
    const services = watchServices(client, () => { /* unused */ })
    const [informer] = informers
    expect(informer.path).toBe('/api/v1/namespaces/yaac/services')
    expect(informer.labelSelector).toBeUndefined()
    await informer.listFn()
    expect(listNamespacedService).toHaveBeenCalledWith({ namespace: 'yaac' })
    informer.objects = [{ metadata: { name: 'yaac-proxy' }, spec: { clusterIP: '10.96.0.50' } } as KubernetesObject]
    expect(services()).toEqual([{ name: 'yaac-proxy', clusterIp: '10.96.0.50' }])
  })
})
