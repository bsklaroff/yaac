/**
 * Cluster-wide pod + Service watches feeding netd's reconcile.
 *
 * `@kubernetes/client-node`'s informer owns the list→watch cycle,
 * resourceVersion bookkeeping, and relist-on-410 — and it keeps the object
 * store itself, so netd holds no cache of its own and simply maps the store
 * on read. A node sees tens to low hundreds of objects, so that mapping is
 * noise next to a reconcile, and it removes every upsert/evict path netd
 * would otherwise have to get right.
 *
 * It also fixes credential lifetime for free: the in-cluster config
 * registers a `tokenFile` auth provider that re-reads the projected
 * ServiceAccount token, which kubelet rotates. Reading that token once at
 * startup — as a hand-rolled client naturally does — eventually 401s a
 * long-lived daemon, and the failure is quiet: reconcile keeps succeeding
 * off the last-known store, so the readiness marker stays while new pods
 * stop being programmed.
 *
 * What the informer does NOT own, verified against 1.4.0 and mirrored from
 * the server's InformerCache: on any non-410 error — a failed initial list
 * included — it emits `error` and STOPS. Restart-with-backoff is ours.
 *
 * Host-mode netd watches pods in ALL namespaces, unlike the proxy: it must
 * see session pods in the install namespace and synced pods in every
 * vcluster namespace, since a pod's veth is what it programs. Services and
 * the redirect-claim ConfigMap it reads only in its OWN namespace — the
 * outer proxy's ClusterIP and the server-authored claims both live there —
 * so its cluster-scoped RBAC is pods alone.
 *
 * Claim-mode netd (inside a vcluster, see claims.ts) watches pods in its own
 * namespace only, and writes one ConfigMap there.
 *
 * There is no periodic resync, so a delete event lost while the watch was
 * down survives until the next restart re-lists. That gap is fail-closed
 * both ways: a ghost POD renders no rules (renderRedirectRules needs a live
 * veth from the node's route table, which a departed pod no longer has), and
 * a stale CLAIM cannot outlive its proxy pod — validation drops any claim
 * whose target is not a live synced pod IP, so the pods fall back to the
 * outer proxy rather than onto a dead address.
 */

import {
  KubeConfig,
  makeInformer,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
  type ObjectCache,
} from '@kubernetes/client-node'
import type { NetdConfigMap } from 'yaac-netd/claims'
import type { NetdPod, NetdService } from 'yaac-netd/targets'

interface RawPod {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  status?: { podIP?: string }
}

interface RawService {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: { clusterIP?: string }
}

interface RawConfigMap {
  metadata?: { name?: string; namespace?: string }
  data?: Record<string, string>
}

/**
 * Map one API Pod object to netd's shape; null when unusable.
 *
 * This is netd's validation boundary — the informer hands over whatever the
 * apiserver sent, and anything missing an identity or an IP is dropped
 * rather than guessed at, because a half-built pod must produce no rules.
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

/**
 * Map one API ConfigMap object to netd's shape; null when unusable. A
 * data-less ConfigMap maps to an empty record rather than being dropped:
 * that is how the server retracts every claim at once, and it must reach
 * the reconcile as "no claims" instead of as "no document".
 */
export function mapConfigMap(raw: unknown): NetdConfigMap | null {
  const cm = raw as RawConfigMap
  const name = cm.metadata?.name
  const namespace = cm.metadata?.namespace
  if (!name || !namespace) return null
  return { name, namespace, data: cm.data ?? {} }
}

/** The informer surface this module drives — lets tests inject a fake. */
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

/** In-cluster config: SA token (re-read on a timer), CA, and API host. */
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
 * when it stops. `list()` reads through to the informer's store, so there
 * is no second copy of cluster state to keep in sync.
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
    // An informer the apiserver dropped after a long, healthy life is
    // routine — restart near-immediately. Only rapid failures back off.
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
    // start() only rejects before the list/watch cycle begins (bad config,
    // unreachable apiserver); mid-cycle failures arrive as `error`.
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

/** All-namespace pods — host mode's veth-bearing population. */
export const PODS_PATH = '/api/v1/pods'

/** Namespaced watch paths. The informer's path is its resync identity, so
 *  it must cover exactly the same scope as the list function beside it. */
export function namespacedPodsPath(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/pods`
}

export function namespacedServicesPath(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/services`
}

export function namespacedConfigMapsPath(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/configmaps`
}
