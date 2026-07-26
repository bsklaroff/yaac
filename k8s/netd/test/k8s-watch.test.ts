import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ErrorCallback,
  KubernetesListObject,
  KubernetesObject,
  ObjectCallback,
} from '@kubernetes/client-node'
import {
  PODS_PATH,
  clusterInformerFactory,
  loadInClusterConfig,
  mapConfigMap,
  mapPod,
  mapService,
  namespacedConfigMapsPath,
  namespacedPodsPath,
  namespacedServicesPath,
  startResourceWatch,
  type InformerLike,
} from 'yaac-netd/k8s-watch'
import { KubeConfig } from '@kubernetes/client-node'

/** Stand-in for client-node's informer: no network, fully driveable. */
class FakeInformer implements InformerLike {
  readonly handlers = new Map<string, Array<(arg?: unknown) => void>>()
  objects: KubernetesObject[] = []
  startCalls = 0
  stopCalls = 0
  startResult: Promise<void> = Promise.resolve()

  // Mirrors the informer's overloaded `on` so the fake satisfies InformerLike.
  on(verb: 'delete' | 'add' | 'update' | 'change', cb: ObjectCallback<KubernetesObject>): void
  on(verb: 'error' | 'connect', cb: ErrorCallback): void
  on(verb: string, cb: ObjectCallback<KubernetesObject> | ErrorCallback): void {
    const list = this.handlers.get(verb) ?? []
    list.push(cb as (arg?: unknown) => void)
    this.handlers.set(verb, list)
  }

  start(): Promise<void> {
    this.startCalls += 1
    return this.startResult
  }

  stop(): Promise<void> {
    this.stopCalls += 1
    return Promise.resolve()
  }

  list(): KubernetesObject[] {
    return this.objects
  }

  emit(verb: string, obj?: unknown): void {
    for (const cb of this.handlers.get(verb) ?? []) cb(obj)
  }
}

const emptyList = (): Promise<KubernetesListObject<KubernetesObject>> =>
  Promise.resolve({ items: [] })

describe('mapPod', () => {
  it('maps an API pod to netd\'s shape', () => {
    expect(mapPod({
      metadata: { name: 'p', namespace: 'yaac', labels: { 'yaac.session-id': 's1' } },
      status: { podIP: '10.244.0.9' },
    })).toEqual({
      name: 'p', namespace: 'yaac', podIp: '10.244.0.9', labels: { 'yaac.session-id': 's1' },
    })
  })

  it('defaults absent labels so callers never see undefined', () => {
    expect(mapPod({ metadata: { name: 'p', namespace: 'n' }, status: { podIP: '1.2.3.4' } }))
      .toMatchObject({ labels: {} })
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
      metadata: { name: 'yaac-proxy', namespace: 'yaac', labels: { app: 'yaac-proxy' } },
      spec: { clusterIP: '10.96.0.50' },
    })).toEqual({
      name: 'yaac-proxy', namespace: 'yaac', clusterIp: '10.96.0.50', labels: { app: 'yaac-proxy' },
    })
  })

  it('keeps headless Services — selectInnerProxies is what rejects "None"', () => {
    expect(mapService({ metadata: { name: 's', namespace: 'n' }, spec: { clusterIP: 'None' } }))
      .toMatchObject({ clusterIp: 'None' })
  })

  it('drops a Service with no ClusterIP or no identity', () => {
    expect(mapService({ metadata: { name: 's', namespace: 'n' }, spec: {} })).toBeNull()
    expect(mapService({ metadata: { name: 's' }, spec: { clusterIP: '10.96.0.1' } })).toBeNull()
  })
})

describe('startResourceWatch', () => {
  let informer: FakeInformer
  let onChange: ReturnType<typeof vi.fn<() => void>>
  let log: ReturnType<typeof vi.fn<(message: string) => void>>

  const build = (): ReturnType<typeof startResourceWatch<{ name: string }>> =>
    startResourceWatch<{ name: string }>({
      path: PODS_PATH,
      listFn: emptyList,
      map: (raw) => {
        const name = (raw as { metadata?: { name?: string } }).metadata?.name
        return name ? { name } : null
      },
      onChange,
      log,
      makeInformerFn: () => informer,
    })

  beforeEach(() => {
    vi.useFakeTimers()
    informer = new FakeInformer()
    onChange = vi.fn<() => void>()
    log = vi.fn<(message: string) => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads through to the informer store, mapping and dropping unusable objects', () => {
    const watch = build()
    informer.objects = [{ metadata: { name: 'a' } }, {}, { metadata: { name: 'b' } }]
    expect(watch.list()).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('notifies on every delta kind', () => {
    build()
    informer.emit('add')
    informer.emit('update')
    informer.emit('delete')
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('starts the informer on start()', () => {
    const watch = build()
    expect(informer.startCalls).toBe(0)
    watch.start()
    expect(informer.startCalls).toBe(1)
  })

  it('restarts with backoff after an error — the informer stops on its own', () => {
    const watch = build()
    watch.start()
    informer.emit('error', new Error('watch closed'))
    expect(informer.startCalls).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)

    // A second rapid failure backs off further, so a broken apiserver is
    // not hammered once a second forever.
    informer.emit('error', new Error('again'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(3)
  })

  it('collapses a burst of errors into one pending restart', () => {
    const watch = build()
    watch.start()
    informer.emit('error', new Error('a'))
    informer.emit('error', new Error('b'))
    informer.emit('error', new Error('c'))
    vi.advanceTimersByTime(5_000)
    expect(informer.startCalls).toBe(2)
  })

  it('resets the backoff after a long healthy run', () => {
    const watch = build()
    watch.start()
    informer.emit('error', new Error('boom'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
    // Healthy for well over a minute, then dropped: that is routine, so the
    // next restart is prompt rather than inheriting the doubled delay.
    vi.advanceTimersByTime(120_000)
    informer.emit('error', new Error('dropped'))
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(3)
  })

  it('treats a start() rejection as an error and retries', async () => {
    informer.startResult = Promise.reject(new Error('no apiserver'))
    const watch = build()
    watch.start()
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(1_000)
    expect(informer.startCalls).toBe(2)
  })

  it('stop() cancels a pending restart and stops the informer', () => {
    const watch = build()
    watch.start()
    informer.emit('error', new Error('boom'))
    watch.stop()
    vi.advanceTimersByTime(60_000)
    expect(informer.startCalls).toBe(1)
    expect(informer.stopCalls).toBe(1)
  })

  it('ignores errors arriving after stop()', () => {
    const watch = build()
    watch.start()
    watch.stop()
    informer.emit('error', new Error('late'))
    vi.advanceTimersByTime(60_000)
    expect(informer.startCalls).toBe(1)
  })
})

describe('clusterInformerFactory', () => {
  it('binds a kubeconfig and builds an informer for the given path', () => {
    const kubeConfig = new KubeConfig()
    kubeConfig.loadFromClusterAndUser(
      { name: 'c', server: 'https://127.0.0.1:6443', skipTLSVerify: true },
      { name: 'u' },
    )
    const informer = clusterInformerFactory(kubeConfig)(namespacedServicesPath('yaac'), emptyList)
    // Constructed but never started, so this touches no network.
    expect(typeof informer.start).toBe('function')
    expect(informer.list()).toEqual([])
  })
})

describe('loadInClusterConfig', () => {
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
    const kubeConfig = loadInClusterConfig()
    expect(kubeConfig.getCurrentCluster()?.server).toBe('https://10.96.0.1:443')
    // tokenFile, not a token: the provider re-reads it, so netd survives
    // kubelet rotating the projected ServiceAccount token.
    const authProvider = kubeConfig.getCurrentUser()?.authProvider as
      { name?: string; config?: { tokenFile?: string } } | undefined
    expect(authProvider?.name).toBe('tokenFile')
    expect(authProvider?.config?.tokenFile).toContain('serviceaccount/token')
  })
})

describe('mapConfigMap', () => {
  it('maps the identity and data', () => {
    expect(mapConfigMap({
      metadata: { name: 'yaac-redirect-claims', namespace: 'yaac' },
      data: { 'yaac-vc-a': '{}' },
    })).toEqual({
      name: 'yaac-redirect-claims', namespace: 'yaac', data: { 'yaac-vc-a': '{}' },
    })
  })

  it('maps a data-less ConfigMap to empty data, not to null', () => {
    // That is how the server retracts every claim at once; it must reach
    // reconcile as "no claims" rather than as "no document".
    expect(mapConfigMap({ metadata: { name: 'c', namespace: 'yaac' } }))
      .toEqual({ name: 'c', namespace: 'yaac', data: {} })
  })

  it('drops a ConfigMap with no identity', () => {
    expect(mapConfigMap({ metadata: { name: 'c' } })).toBeNull()
    expect(mapConfigMap({})).toBeNull()
  })
})

describe('namespaced watch paths', () => {
  it('scope the watch to one namespace', () => {
    // Host mode reads Services and claims from its OWN namespace only, and
    // claim mode reads pods from its own — that scoping is what keeps netd's
    // cluster-wide read down to pods.
    expect(namespacedPodsPath('yaac')).toBe('/api/v1/namespaces/yaac/pods')
    expect(namespacedServicesPath('yaac')).toBe('/api/v1/namespaces/yaac/services')
    expect(namespacedConfigMapsPath('yaac')).toBe('/api/v1/namespaces/yaac/configmaps')
  })
})
