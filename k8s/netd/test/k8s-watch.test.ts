import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as clientNode from '@kubernetes/client-node'
import type { KubernetesObject } from '@kubernetes/client-node'
import { inClusterClient, mapNodePod, watchNodePods } from 'yaac-netd/k8s-watch'

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
    readonly fieldSelector: string | undefined,
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
  ListWatch: function (
    path: string, _watch: unknown, listFn: () => Promise<unknown>, _autoStart: boolean,
    labelSelector?: string, fieldSelector?: string,
  ) {
    const informer = new FakeInformer(path, listFn, labelSelector, fieldSelector)
    informers.push(informer)
    return informer
  },
}))

/** A client whose list calls record their arguments instead of dialing. */
function fakeClient() {
  const listNamespacedPod = vi.fn(() => Promise.resolve({ items: [] }))
  const client = {
    kubeConfig: {},
    core: { listNamespacedPod },
    namespace: 'yaac',
  } as unknown as Parameters<typeof watchNodePods>[0]
  return { client, listNamespacedPod }
}

describe('mapNodePod', () => {
  it('maps a running pod to its uid and memory request, init containers included', () => {
    expect(mapNodePod({
      metadata: { name: 'ws', uid: 'a1-b2', labels: { 'yaac.workspace-id': 'a1' } },
      status: { phase: 'Running' },
      spec: {
        containers: [{ resources: { requests: { memory: '2Gi' } } }],
        initContainers: [{ resources: { requests: { memory: '16Mi' } } }],
      },
    })).toEqual({ name: 'ws', uid: 'a1-b2', memoryRequestBytes: 2 * 1024 ** 3, workspace: true })
  })

  it('marks as workspaces only what the workspace selector matches', () => {
    const running = (labels?: Record<string, string>) =>
      mapNodePod({ metadata: { name: 'p', uid: 'u', labels }, status: { phase: 'Running' } })?.workspace
    expect(running({ 'yaac.workspace-id': 'a1' })).toBe(true)
    expect(running({ 'yaac.workspace-id': 'a1', app: 'yaac-proxy' })).toBe(false)
    expect(running({ app: 'yaac-registry' })).toBe(false)
    expect(running()).toBe(false)
  })

  it('drops a pod that is not running or has no uid', () => {
    expect(mapNodePod({ metadata: { name: 'p', uid: 'u' }, status: { phase: 'Pending' } })).toBeNull()
    expect(mapNodePod({ metadata: { name: 'p' }, status: { phase: 'Running' } })).toBeNull()
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

describe('watchNodePods', () => {
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

  it('watches and lists every pod of this install on this node, by field selector', async () => {
    const { client, listNamespacedPod } = fakeClient()
    watchNodePods(client, 'node-a', onChange)
    const [informer] = informers
    expect(informer.path).toBe('/api/v1/namespaces/yaac/pods')
    expect(informer.labelSelector).toBeUndefined()
    expect(informer.fieldSelector).toBe('spec.nodeName=node-a')
    // client-node applies the selector to the watch only.
    await informer.listFn()
    expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'yaac', fieldSelector: 'spec.nodeName=node-a' })
  })

  it('reads through to the store, mapping and dropping pods that are not running', () => {
    const pods = watchNodePods(fakeClient().client, 'node-a', onChange)
    informers[0].objects = [
      { metadata: { name: 'a', uid: 'u1' }, status: { phase: 'Running' }, spec: { containers: [] } } as KubernetesObject,
      { metadata: { name: 'pending', uid: 'u2' }, status: { phase: 'Pending' } } as KubernetesObject,
    ]
    expect(pods().map((p) => p.name)).toEqual(['a'])
  })

  it('starts at once and notifies on every delta kind', () => {
    watchNodePods(fakeClient().client, 'node-a', onChange)
    const [informer] = informers
    expect(informer.startCalls).toBe(1)
    informer.emit('add')
    informer.emit('update')
    informer.emit('delete')
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('restarts with doubling backoff after errors, one restart per burst', () => {
    // client-node's informer stops on any non-410 error.
    watchNodePods(fakeClient().client, 'node-a', onChange)
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
    watchNodePods(fakeClient().client, 'node-a', onChange)
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
    watchNodePods(fakeClient().client, 'node-a', onChange)
    const [informer] = informers
    informer.startResult = () => Promise.reject(new Error('no apiserver'))
    informer.emit('error', new Error('first'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(informer.startCalls).toBe(3)
  })
})
