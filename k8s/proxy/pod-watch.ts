/**
 * Source-IP → worktree resolution for the transparent listeners.
 *
 * netd's node-local Envoy receives redirected worktree-pod egress and stamps
 * the real source pod IP in the upstream PROXY-protocol header (it cannot be
 * spoofed — Envoy reads it off the connection's own peer address). This module
 * turns that IP into a worktree id by reading the pod's own
 * `yaac.worktree-id` label, keeping a `podIP → worktreeId` index fresh from a client-node
 * informer over this namespace's worktree pods. Authoritative and self-
 * correcting: a DELETED event evicts the IP, so a reused IP can never be
 * misattributed, and the informer's every (re)list diffs against its own
 * store and emits `delete` for anything that vanished while it was
 * disconnected — so the index cannot accumulate ghosts.
 *
 * Using the library rather than a hand-rolled watch also fixes credential
 * lifetime: the in-cluster config registers a `tokenFile` auth provider
 * that re-reads the projected ServiceAccount token kubelet rotates. Reading
 * that token once at startup eventually 401s a long-lived proxy, and the
 * failure is quiet — the index simply stops learning about new worktree
 * pods, whose traffic then fails closed as "unknown source".
 *
 * The index (PodWorktreeIndex) is pure and unit-tested; the informer wiring
 * (startPodWatch) is covered by e2e.
 */

import {
  CoreV1Api,
  KubeConfig,
  makeInformer,
  type KubernetesObject,
} from '@kubernetes/client-node'
/**
 * Must match LABEL_WORKTREE_ID in
 * packages/server/src/drivers/k8s/substrate/pods.ts (proxy can't import
 * src/) — the key every worktree pod carries and every selector matches on.
 */
export const LABEL_WORKTREE_ID = 'yaac.worktree-id'

/** The shape we read out of a Pod object (only the fields we need). */
export interface WatchedPod {
  metadata?: { labels?: Record<string, string> }
  status?: { podIP?: string }
}

export interface PodWatchEvent {
  /** ADDED | MODIFIED | DELETED (k8s watch verbs). */
  type: string
  object: WatchedPod
}

/** worktreeId carried by a pod, or null if it has no IP / worktree label yet. */
export function podWorktreeId(pod: WatchedPod): string | null {
  const ip = pod.status?.podIP
  const sid = pod.metadata?.labels?.[LABEL_WORKTREE_ID]
  if (!ip || !sid) return null
  return sid
}

/**
 * In-memory `podIP → worktreeId` index. Updated incrementally from watch
 * events (apply) and wholesale on a re-list (replaceAll, which evicts pods
 * that vanished while disconnected).
 */
export class PodWorktreeIndex {
  private byIp = new Map<string, string>()
  // Reverse map for the relay listener (worktreeId → podIP). Maintained
  // alongside byIp; a replaced pod's upsert repoints the worktree at its new
  // IP, and a DELETED event only evicts the reverse entry when it still
  // points at the deleted pod's IP (the new pod's entry must survive the
  // old pod's deletion event arriving late).
  private byId = new Map<string, string>()

  /** Apply one watch event. ADDED/MODIFIED upsert; DELETED (or a pod that
   * lost its IP/label) evicts. */
  apply(ev: PodWatchEvent): void {
    const ip = ev.object.status?.podIP
    if (!ip) return
    const sid = podWorktreeId(ev.object)
    if (ev.type === 'DELETED' || sid === null) {
      const evicted = this.byIp.get(ip)
      this.byIp.delete(ip)
      if (evicted !== undefined && this.byId.get(evicted) === ip) this.byId.delete(evicted)
      return
    }
    this.byIp.set(ip, sid)
    this.byId.set(sid, ip)
  }

  /** Rebuild the whole index from a list (the re-seed after a (re)connect). */
  replaceAll(pods: WatchedPod[]): void {
    this.byIp.clear()
    this.byId.clear()
    for (const object of pods) this.apply({ type: 'ADDED', object })
  }

  /** Synchronous cache lookup (the hot path). */
  resolve(ip: string): string | undefined {
    return this.byIp.get(ip)
  }

  /** Reverse lookup for the relay listener: the worktree's pod IP. */
  resolveIp(worktreeId: string): string | undefined {
    return this.byId.get(worktreeId)
  }

  set(ip: string, worktreeId: string): void {
    this.byIp.set(ip, worktreeId)
    this.byId.set(worktreeId, ip)
  }

  get size(): number {
    return this.byIp.size
  }
}

/**
 * Parse the body of `PUT /vcluster-attribution` — a flat `{ podIP: worktreeId }`
 * object the host server pushes so the OUTER proxy can attribute a vcluster's
 * chained egress (its inner proxy's upstream dials, and synced pods before an
 * inner yaac opts in) to the OWNING outer worktree. Those pods live in another
 * host namespace with no `yaac.worktree-id` of their own (or only the *inner*
 * worktree's), so the pod-watch can't resolve them; the server — which knows each
 * vcluster namespace's owning worktree and reads the host pod IPs — supplies the
 * map instead. Full-replace semantics (the server sends the complete current set
 * each tick), so a stale IP is evicted on the next push.
 *
 * Returns null for anything that isn't an object of string→non-empty-string, so
 * the endpoint rejects a malformed body rather than poisoning attribution.
 */
export function parseVclusterAttribution(body: string): Map<string, string> | null {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out = new Map<string, string>()
  for (const [ip, sid] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof sid !== 'string' || !sid || !ip) return null
    out.set(ip, sid)
  }
  return out
}

// ── In-cluster API access (client-node) ────────────────────────────────────

/** Lazily-built in-cluster client + the namespace this proxy serves. */
interface ApiClient {
  core: CoreV1Api
  namespace: string
  /** Kept so the informer and the API client share one credential source. */
  kubeConfig: KubeConfig
}

let cachedClient: ApiClient | null = null

/**
 * In-cluster config: API host from the injected env, CA and namespace from
 * the ServiceAccount mount, and a `tokenFile` auth provider that re-reads
 * the rotating token rather than snapshotting it.
 */
export function inClusterClient(supplied?: KubeConfig): ApiClient {
  if (cachedClient) return cachedClient
  let kubeConfig = supplied
  if (!kubeConfig) {
    kubeConfig = new KubeConfig()
    kubeConfig.loadFromCluster()
  }
  const namespace = kubeConfig.getContextObject(kubeConfig.getCurrentContext())?.namespace
  if (!namespace) {
    throw new Error('proxy: no in-cluster namespace — is the ServiceAccount mounted?')
  }
  cachedClient = { core: kubeConfig.makeApiClient(CoreV1Api), namespace, kubeConfig }
  return cachedClient
}

/** Reset the memoized client (tests only). */
export function _resetInClusterClientForTests(): void {
  cachedClient = null
}

/** Every worktree pod in this namespace — the informer's scope and its seed. */
const WORKTREE_POD_SELECTOR = LABEL_WORKTREE_ID

/**
 * Feed `index` from an informer over this namespace's worktree pods, for the
 * proxy's lifetime.
 *
 * The informer owns the list→watch cycle, resourceVersion bookkeeping, and
 * relist-on-410; what it does NOT own is restart, because on any non-410
 * error (a failed initial list included) it emits `error` and stops. Hence
 * the backoff loop below — a proxy whose index stops updating fails every
 * new worktree closed, so giving up is not an option.
 */
export function startPodWatch(index: PodWorktreeIndex, client = inClusterClient()): void {
  const path = `/api/v1/namespaces/${client.namespace}/pods`
  // client-node applies labelSelector to the WATCH only, so the list must
  // carry it too or the seed would pull in every pod in the namespace.
  const listFn = (): ReturnType<CoreV1Api['listNamespacedPod']> =>
    client.core.listNamespacedPod({
      namespace: client.namespace,
      labelSelector: WORKTREE_POD_SELECTOR,
    })
  const informer = makeInformer(client.kubeConfig, path, listFn, WORKTREE_POD_SELECTOR)

  const feed = (type: string) => (obj: KubernetesObject): void => {
    index.apply({ type, object: obj as WatchedPod })
  }
  informer.on('add', feed('ADDED'))
  informer.on('update', feed('MODIFIED'))
  informer.on('delete', feed('DELETED'))

  let backoffMs = 1_000
  let startedAtMs = 0
  let restartTimer: NodeJS.Timeout | null = null
  const begin = (): void => {
    startedAtMs = Date.now()
    informer.start().catch((err: unknown) => { onError(err) })
  }
  const onError = (err: unknown): void => {
    // A watch the apiserver dropped after a long, healthy life is routine;
    // only rapid failures back off.
    if (Date.now() - startedAtMs >= 60_000) backoffMs = 1_000
    console.error(`[proxy] pod-watch: ${String(err)} — restart in ${backoffMs}ms`)
    // One pending restart at a time: a failing start can emit both a
    // rejected promise and an 'error' event, and each stacked timer would
    // start another informer that never stops (same guard as netd's
    // startResourceWatch).
    if (restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      begin()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
  informer.on('error', (err: unknown) => { onError(err) })
  informer.on('connect', () => { console.log('[proxy] pod-watch: connected') })
  begin()
}

/**
 * Relay cache-miss fallback: a stream dial can beat the pod's watch event.
 * Look the pod up by its worktree-id label, populate the index, and return
 * its IP (or undefined → the relay fails closed).
 */
export async function fetchPodIpByWorktreeId(
  index: PodWorktreeIndex,
  worktreeId: string,
  client = inClusterClient(),
): Promise<string | undefined> {
  const list = await client.core.listNamespacedPod({
    namespace: client.namespace,
    labelSelector: `${LABEL_WORKTREE_ID}=${worktreeId}`,
  })
  for (const pod of list.items) {
    const ip = pod.status?.podIP
    if (ip && podWorktreeId(pod as WatchedPod) === worktreeId) {
      index.set(ip, worktreeId)
      return ip
    }
  }
  return undefined
}

/**
 * Cache-miss fallback: a brand-new pod's first packet can beat its watch
 * event. Look the pod up directly by IP, populate the index, and return its
 * worktree (or undefined → the caller fails closed).
 */
export async function fetchWorktreeByPodIp(
  index: PodWorktreeIndex,
  ip: string,
  client = inClusterClient(),
): Promise<string | undefined> {
  const list = await client.core.listNamespacedPod({
    namespace: client.namespace,
    labelSelector: WORKTREE_POD_SELECTOR,
    fieldSelector: `status.podIP=${ip}`,
  })
  for (const pod of list.items) {
    const sid = podWorktreeId(pod as WatchedPod)
    if (sid && pod.status?.podIP === ip) {
      index.set(ip, sid)
      return sid
    }
  }
  return undefined
}
