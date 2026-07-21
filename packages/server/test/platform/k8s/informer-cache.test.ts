import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { KubernetesListObject, KubernetesObject } from '@kubernetes/client-node'
import { InformerCache, type InformerLike } from '#platform/k8s/informer-cache'

/**
 * Fake for the client-node informer surface: records lifecycle calls and
 * lets tests emit add/update/delete/connect/error events by hand.
 */
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

interface Row {
  name: string
  v: number
}

function rawRow(name: string, v = 0): KubernetesObject {
  return { metadata: { name }, spec: { v } } as unknown as KubernetesObject
}

function mapRow(obj: unknown): Row | null {
  const o = obj as { metadata?: { name?: unknown }; spec?: { v?: unknown } }
  if (typeof o?.metadata?.name !== 'string') return null
  return { name: o.metadata.name, v: typeof o.spec?.v === 'number' ? o.spec.v : 0 }
}

function makeCache(overrides: {
  listItems?: () => KubernetesObject[]
  listError?: () => Error | null
  relistIntervalMs?: number
  restartDelayMs?: number
  maxRestartDelayMs?: number
} = {}): { cache: InformerCache<Row>; informer: FakeInformer; listCalls: () => number; log: string[] } {
  const informer = new FakeInformer()
  const log: string[] = []
  let listCalls = 0
  const cache = new InformerCache<Row>({
    path: '/api/v1/namespaces/test/widgets',
    listFn: () => {
      listCalls += 1
      const err = overrides.listError?.()
      if (err) return Promise.reject(err)
      return Promise.resolve({
        items: overrides.listItems?.() ?? [],
      } as KubernetesListObject<KubernetesObject>)
    },
    mapItem: mapRow,
    keyOf: (row) => row.name,
    makeInformerFn: () => informer,
    relistIntervalMs: overrides.relistIntervalMs ?? 60_000,
    restartDelayMs: overrides.restartDelayMs ?? 1_000,
    maxRestartDelayMs: overrides.maxRestartDelayMs ?? 30_000,
    log: (msg) => log.push(msg),
  })
  return { cache, informer, listCalls: () => listCalls, log }
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InformerCache', () => {
  it('seeds from the list on start and notifies once', async () => {
    const { cache, listCalls } = makeCache({ listItems: () => [rawRow('a', 1)] })
    const changes = vi.fn()
    cache.onChange(changes)
    cache.start()
    await flush()
    expect(cache.items()).toEqual([{ name: 'a', v: 1 }])
    expect(changes).toHaveBeenCalledTimes(1)
    expect(listCalls()).toBe(1)
    cache.stop()
  })

  it('is healthy only once seeded AND watch-connected', async () => {
    const { cache, informer } = makeCache()
    expect(cache.healthy()).toBe(false)
    cache.start()
    await flush()
    expect(cache.healthy()).toBe(false)
    informer.emit('connect')
    expect(cache.healthy()).toBe(true)
    cache.stop()
    expect(cache.healthy()).toBe(false)
  })

  it('applies add/update/delete events and dedupes no-op updates', async () => {
    const { cache, informer } = makeCache()
    cache.start()
    await flush()
    const changes = vi.fn()
    cache.onChange(changes)

    informer.emit('add', rawRow('a', 1))
    expect(cache.items()).toEqual([{ name: 'a', v: 1 }])
    informer.emit('update', rawRow('a', 2))
    expect(cache.items()).toEqual([{ name: 'a', v: 2 }])
    // Identical mapped object (e.g. a resourceVersion-only bump) → no notify.
    informer.emit('update', rawRow('a', 2))
    expect(changes).toHaveBeenCalledTimes(2)
    informer.emit('delete', rawRow('a', 2))
    expect(cache.items()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(3)
    // Deleting an unknown key is a no-op.
    informer.emit('delete', rawRow('ghost'))
    expect(changes).toHaveBeenCalledTimes(3)
    cache.stop()
  })

  it('skips objects the mapper rejects', async () => {
    const { cache, informer } = makeCache()
    cache.start()
    await flush()
    informer.emit('add', { metadata: {} })
    expect(cache.items()).toEqual([])
    cache.stop()
  })

  it('isolates a throwing change listener', async () => {
    const { cache, informer, log } = makeCache()
    cache.start()
    await flush()
    cache.onChange(() => { throw new Error('boom') })
    const second = vi.fn()
    cache.onChange(second)
    informer.emit('add', rawRow('a'))
    expect(second).toHaveBeenCalled()
    expect(log.some((l) => l.includes('change listener failed'))).toBe(true)
    cache.stop()
  })

  it('restarts with doubling backoff after informer errors', async () => {
    const { cache, informer } = makeCache({ restartDelayMs: 1_000, maxRestartDelayMs: 4_000 })
    cache.start()
    await flush()
    expect(informer.startCalls).toBe(1)

    informer.emit('connect')
    informer.emit('error', new Error('watch died'))
    expect(cache.healthy()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(informer.startCalls).toBe(2)

    // Rapid second failure → doubled delay.
    informer.emit('error', new Error('watch died again'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(informer.startCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(informer.startCalls).toBe(3)
    cache.stop()
  })

  it('resets the backoff after a long-lived watch', async () => {
    const { cache, informer } = makeCache({ restartDelayMs: 1_000 })
    cache.start()
    await flush()
    // Drive the backoff up with rapid failures.
    informer.emit('error', new Error('e1'))
    await vi.advanceTimersByTimeAsync(1_000)
    informer.emit('error', new Error('e2'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(informer.startCalls).toBe(3)
    // A failure after ≥60s of uptime restarts at the base delay again.
    await vi.advanceTimersByTimeAsync(61_000)
    informer.emit('error', new Error('e3'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(informer.startCalls).toBe(4)
    cache.stop()
  })

  it('treats a rejected informer start as an error (restarts)', async () => {
    const { cache, informer } = makeCache({ restartDelayMs: 1_000 })
    informer.startImpl = () => Promise.reject(new Error('no cluster'))
    cache.start()
    await flush()
    informer.startImpl = () => Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(informer.startCalls).toBe(2)
    cache.stop()
  })

  it('relists on the interval, repairing ghost rows', async () => {
    let items = [rawRow('a', 1)]
    const { cache, listCalls } = makeCache({ listItems: () => items, relistIntervalMs: 60_000 })
    const changes = vi.fn()
    cache.onChange(changes)
    cache.start()
    await flush()
    expect(cache.items()).toEqual([{ name: 'a', v: 1 }])

    // Simulate a missed DELETE + missed ADD: the next relist replaces the set.
    items = [rawRow('b', 2)]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cache.items()).toEqual([{ name: 'b', v: 2 }])
    expect(changes).toHaveBeenCalledTimes(2)
    expect(listCalls()).toBe(2)
    cache.stop()
  })

  it('keeps the cache and logs when a relist fails', async () => {
    let fail = false
    const { cache, log } = makeCache({
      listItems: () => [rawRow('a', 1)],
      listError: () => (fail ? new Error('cluster hiccup') : null),
    })
    cache.start()
    await flush()
    fail = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cache.items()).toEqual([{ name: 'a', v: 1 }])
    expect(log.some((l) => l.includes('relist failed'))).toBe(true)
    cache.stop()
  })

  it('stop() halts the informer, restarts, and relists', async () => {
    const { cache, informer, listCalls } = makeCache()
    cache.start()
    await flush()
    informer.emit('error', new Error('watch died'))
    cache.stop()
    expect(informer.stopCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(informer.startCalls).toBe(1)
    expect(listCalls()).toBe(1)
  })
})
