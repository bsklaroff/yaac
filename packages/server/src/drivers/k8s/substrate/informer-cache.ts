import {
  ListWatch,
  Watch,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
} from '@kubernetes/client-node'
import { getKubeConfig } from './client'
import { serverLog } from '#log'

/**
 * Watch-fed cache of one resource kind, mapped to a yaac type. client-node's
 * informer handles the watch stream, resourceVersion and relist on 410.
 * This class covers what it does not (checked against client-node 2.0.0):
 *
 * - On any other error, including a failed list, the informer emits
 *   `error` and stops. We restart it with backoff.
 * - It has no periodic resync, so an event lost while the watch was down
 *   would leave a stale entry forever. A periodic relist bounds that.
 * - The list path yields class instances (Date timestamps) and the watch
 *   path raw JSON (string timestamps). `mapItem` must accept both.
 * - Its watch request times out every 30s, and while no events arrive it
 *   waits a growing delay (up to 30s) before reconnecting, which would
 *   hold back the next event as long. We reconnect at once: the watch
 *   resumes from the last resourceVersion, and a real failure is an
 *   `error` we restart with our own backoff.
 */

/** Informer surface the cache drives — lets tests inject a fake. */
export type InformerLike = Pick<Informer<KubernetesObject>, 'on' | 'start' | 'stop'>

export type MakeInformerFn = (
  path: string,
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>,
  labelSelector?: string,
) => InformerLike

export interface InformerCacheDeps<T> {
  /** API path, e.g. `/api/v1/namespaces/yaac/pods`. */
  path: string
  /**
   * List for the informer's seed AND the periodic relist. Must apply
   * `labelSelector` itself — client-node applies it to the watch only.
   */
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>
  labelSelector?: string
  /** Validate+map one raw object; null = not ours / malformed (skipped). */
  mapItem: (obj: unknown) => T | null
  keyOf: (item: T) => string
  /** Injected for tests — replaces the real client-node informer. */
  makeInformerFn?: MakeInformerFn
  /** Full relist cadence bounding ghost-row lifetime. Default 60s. */
  relistIntervalMs?: number
  /** First restart delay after an informer error; doubles to the max. */
  restartDelayMs?: number
  maxRestartDelayMs?: number
  log?: (msg: string) => void
}

function realMakeInformer(
  path: string,
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>,
  labelSelector?: string,
): InformerLike {
  return new ListWatch(path, new Watch(getKubeConfig()), listFn, false, labelSelector, undefined, {
    delayFn: () => Promise.resolve(),
  })
}

export class InformerCache<T> {
  private readonly cache = new Map<string, T>()
  private readonly listeners = new Set<() => void>()
  private informer: InformerLike | null = null
  private stopped = true
  private seeded = false
  private connected = false
  private startedAtMs = 0
  private restartTimer: NodeJS.Timeout | null = null
  private relistTimer: NodeJS.Timeout | null = null
  private backoffMs: number

  private readonly deps: Required<Pick<InformerCacheDeps<T>,
    'makeInformerFn' | 'relistIntervalMs' | 'restartDelayMs' | 'maxRestartDelayMs' | 'log'>>
    & InformerCacheDeps<T>

  constructor(deps: InformerCacheDeps<T>) {
    this.deps = {
      makeInformerFn: realMakeInformer,
      relistIntervalMs: 60_000,
      restartDelayMs: 1_000,
      maxRestartDelayMs: 30_000,
      log: serverLog,
      ...deps,
    }
    this.backoffMs = this.deps.restartDelayMs
  }

  /** Register a change handler (fired on any observed delta). */
  onChange(fn: () => void): void {
    this.listeners.add(fn)
  }

  items(): T[] {
    return [...this.cache.values()]
  }

  /**
   * Seeded and watch-connected, so a missing item really is absent. When
   * false, destructive consumers should do a live list instead.
   */
  healthy(): boolean {
    return this.seeded && this.connected
  }

  start(): void {
    this.stopped = false
    const informer = this.deps.makeInformerFn(
      this.deps.path, this.deps.listFn, this.deps.labelSelector)
    this.informer = informer
    informer.on('add', (obj) => this.upsert(obj))
    informer.on('update', (obj) => this.upsert(obj))
    informer.on('delete', (obj) => this.remove(obj))
    informer.on('connect', () => { this.connected = true })
    informer.on('error', (err) => this.onError(err))
    // Seed via our own relist so `items()` works even if the watch is
    // broken.
    void this.relist()
    this.startInformer()
    this.relistTimer = setInterval(() => void this.relist(), this.deps.relistIntervalMs)
  }

  stop(): void {
    this.stopped = true
    this.connected = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.relistTimer) clearInterval(this.relistTimer)
    this.restartTimer = null
    this.relistTimer = null
    void this.informer?.stop()
    this.informer = null
  }

  private startInformer(): void {
    this.startedAtMs = Date.now()
    // start() only rejects before the list/watch cycle begins (e.g. no
    // cluster in the kubeconfig); mid-cycle failures arrive as `error`.
    this.informer?.start().catch((err: unknown) => this.onError(err))
  }

  private onError(err: unknown): void {
    if (this.stopped) return
    this.connected = false
    // A disconnect after a long run is routine, so reset the backoff.
    if (Date.now() - this.startedAtMs >= 60_000) this.backoffMs = this.deps.restartDelayMs
    this.deps.log(`[server] informer ${this.deps.path}: ${String(err)} — restart in ${this.backoffMs}ms`)
    if (this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.startInformer()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.deps.maxRestartDelayMs)
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (err) {
        this.deps.log(`[server] informer ${this.deps.path}: change listener failed: ${String(err)}`)
      }
    }
  }

  private upsert(obj: unknown): void {
    const item = this.deps.mapItem(obj)
    if (item === null) return
    const key = this.deps.keyOf(item)
    const prev = this.cache.get(key)
    this.cache.set(key, item)
    if (JSON.stringify(prev) !== JSON.stringify(item)) this.notify()
  }

  private remove(obj: unknown): void {
    const item = this.deps.mapItem(obj)
    if (item === null) return
    if (this.cache.delete(this.deps.keyOf(item))) this.notify()
  }

  /** Replace the cache with a fresh full list; notify if anything differs. */
  private async relist(): Promise<void> {
    let list: KubernetesListObject<KubernetesObject>
    try {
      list = await this.deps.listFn()
    } catch (err) {
      // Cluster hiccup — keep the current cache; the next relist retries.
      this.deps.log(`[server] informer ${this.deps.path}: relist failed: ${String(err)}`)
      return
    }
    if (this.stopped) return
    const next = new Map<string, T>()
    for (const obj of list.items) {
      const item = this.deps.mapItem(obj)
      if (item !== null) next.set(this.deps.keyOf(item), item)
    }
    const changed = next.size !== this.cache.size
      || [...next.entries()].some(([key, item]) =>
        JSON.stringify(this.cache.get(key)) !== JSON.stringify(item))
    this.cache.clear()
    for (const [key, item] of next) this.cache.set(key, item)
    this.seeded = true
    if (changed) this.notify()
  }
}
