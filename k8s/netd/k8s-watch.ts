/**
 * Pod and Service watches that feed netd's reconcile.
 *
 * Built on `@kubernetes/client-node` informers, which handle list/watch,
 * relist on 410, and keep the object store; netd maps that store on each
 * read instead of keeping its own cache. The in-cluster config re-reads
 * the rotated ServiceAccount token, so a long-lived netd keeps its
 * credentials.
 *
 * An informer stops after any non-410 error (including a failed initial
 * list), so this module restarts it with backoff.
 *
 * Pods are watched in all namespaces; Services only in netd's own
 * namespace, where the proxy's ClusterIP lives. A delete missed while the
 * watch was down leaves a stale pod in the store, but it renders no rules
 * because it no longer has a veth in the node's route table.
 */

import {
  KubeConfig,
  makeInformer,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
  type ObjectCache,
} from '@kubernetes/client-node'
import type { NetdPod, NetdService } from 'yaac-netd/targets'

interface RawPod {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  status?: { podIP?: string }
}

interface RawService {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: { clusterIP?: string }
}

/**
 * Map one API Pod object to netd's shape; null when it lacks a name,
 * namespace or IP, so a half-built pod produces no rules.
 */
export function mapPod(raw: unknown): NetdPod | null {
  const pod = raw as RawPod
  const name = pod.metadata?.name
  const namespace = pod.metadata?.namespace
  const podIp = pod.status?.podIP
  if (!name || !namespace || !podIp) return null
  return { name, namespace, podIp, labels: pod.metadata?.labels ?? {} }
}

/** Map one API Service object to netd's shape; null when unusable. */
export function mapService(raw: unknown): NetdService | null {
  const svc = raw as RawService
  const name = svc.metadata?.name
  const namespace = svc.metadata?.namespace
  const clusterIp = svc.spec?.clusterIP
  if (!name || !namespace || !clusterIp) return null
  return { name, namespace, clusterIp, labels: svc.metadata?.labels ?? {} }
}

/** The informer methods this module uses, so tests can inject a fake. */
export type InformerLike =
  Pick<Informer<KubernetesObject>, 'on' | 'start' | 'stop'>
  & Pick<ObjectCache<KubernetesObject>, 'list'>

export type MakeInformerFn = (
  path: string,
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>,
) => InformerLike

/** The real informer factory, bound to an in-cluster kubeconfig. */
export function clusterInformerFactory(kubeConfig: KubeConfig): MakeInformerFn {
  return (path, listFn) => makeInformer(kubeConfig, path, listFn)
}

/** In-cluster config: ServiceAccount token (re-read), CA, and API host. */
export function loadInClusterConfig(): KubeConfig {
  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromCluster()
  return kubeConfig
}

export interface ResourceWatchDeps<T> {
  /** Watch path, e.g. `/api/v1/pods` (all namespaces). */
  path: string
  /** Seed list; must cover the same scope as `path`. */
  listFn: () => Promise<KubernetesListObject<KubernetesObject>>
  map: (raw: unknown) => T | null
  /** Called on every observed delta; netd debounces these into a reconcile. */
  onChange: () => void
  log: (message: string) => void
  makeInformerFn: MakeInformerFn
  /** First restart delay after an informer error; doubles to the max. */
  restartDelayMs?: number
  maxRestartDelayMs?: number
}

export interface ResourceWatch<T> {
  /** Everything currently known, mapped; unusable objects dropped. */
  list(): T[]
  start(): void
  stop(): void
}

/**
 * Watch one resource kind forever, restarting the informer with backoff
 * when it stops. The backoff resets if the informer ran for a minute or
 * more before failing. `list()` reads the informer's store directly.
 */
export function startResourceWatch<T>(deps: ResourceWatchDeps<T>): ResourceWatch<T> {
  const baseDelayMs = deps.restartDelayMs ?? 1_000
  const maxDelayMs = deps.maxRestartDelayMs ?? 30_000
  let backoffMs = baseDelayMs
  let startedAtMs = 0
  let restartTimer: NodeJS.Timeout | null = null
  let stopped = true

  const onError = (err: unknown): void => {
    if (stopped) return
    if (Date.now() - startedAtMs >= 60_000) backoffMs = baseDelayMs
    deps.log(`[netd] watch ${deps.path}: ${String(err)} — restart in ${backoffMs}ms`)
    if (restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      begin()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, maxDelayMs)
  }

  const informer = deps.makeInformerFn(deps.path, deps.listFn)
  informer.on('add', () => { deps.onChange() })
  informer.on('update', () => { deps.onChange() })
  informer.on('delete', () => { deps.onChange() })
  informer.on('error', (err: unknown) => { onError(err) })

  function begin(): void {
    startedAtMs = Date.now()
    // start() rejects only before the cycle begins; later failures arrive
    // as `error`.
    informer.start().catch((err: unknown) => { onError(err) })
  }

  return {
    list: () => informer.list()
      .map((obj) => deps.map(obj))
      .filter((item): item is T => item !== null),
    start: () => {
      stopped = false
      begin()
    },
    stop: () => {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      void informer.stop()
    },
  }
}

/** Pods in all namespaces. */
export const PODS_PATH = '/api/v1/pods'

/** Namespaced Services watch path; must match the list function's scope. */
export function namespacedServicesPath(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/services`
}

