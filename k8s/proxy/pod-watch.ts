/**
 * Source-IP → session resolution for the transparent listeners.
 *
 * The node-local Cilium Envoy redirects session-pod egress here and stamps
 * the real source pod IP in the upstream PROXY-protocol header (it cannot be
 * spoofed — Cilium sets it from eBPF-verified endpoint metadata). This module
 * turns that IP into a session id by reading the pod's own `yaac.session-id`
 * label, keeping a `podIP → sessionId` index fresh by watching the pods API
 * with the proxy's read-only ServiceAccount. Authoritative and self-
 * correcting: a DELETED event evicts the IP, so a reused IP can never be
 * misattributed.
 *
 * The index (PodSessionIndex) is pure and unit-tested; the network watch
 * (startPodWatch) is covered by e2e.
 */

import fs from 'node:fs'
import https from 'node:https'

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
/** Must match LABEL_SESSION_ID in src/lib/k8s/pods.ts (proxy can't import src/). */
export const LABEL_SESSION_ID = 'yaac.session-id'

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

/** sessionId carried by a pod, or null if it has no IP / session label yet. */
export function podSessionId(pod: WatchedPod): string | null {
  const ip = pod.status?.podIP
  const sid = pod.metadata?.labels?.[LABEL_SESSION_ID]
  if (!ip || !sid) return null
  return sid
}

/**
 * In-memory `podIP → sessionId` index. Updated incrementally from watch
 * events (apply) and wholesale on a re-list (replaceAll, which evicts pods
 * that vanished while disconnected).
 */
export class PodSessionIndex {
  private byIp = new Map<string, string>()

  /** Apply one watch event. ADDED/MODIFIED upsert; DELETED (or a pod that
   * lost its IP/label) evicts. */
  apply(ev: PodWatchEvent): void {
    const ip = ev.object.status?.podIP
    if (!ip) return
    const sid = podSessionId(ev.object)
    if (ev.type === 'DELETED' || sid === null) {
      this.byIp.delete(ip)
      return
    }
    this.byIp.set(ip, sid)
  }

  /** Rebuild the whole index from a list (the re-seed after a (re)connect). */
  replaceAll(pods: WatchedPod[]): void {
    this.byIp.clear()
    for (const object of pods) this.apply({ type: 'ADDED', object })
  }

  /** Synchronous cache lookup (the hot path). */
  resolve(ip: string): string | undefined {
    return this.byIp.get(ip)
  }

  set(ip: string, sessionId: string): void {
    this.byIp.set(ip, sessionId)
  }

  get size(): number {
    return this.byIp.size
  }
}

// ── In-cluster API client (built-in https; no kube client library) ──────────

interface ApiConfig {
  host: string
  port: string
  token: string
  ca: Buffer
  namespace: string
}

function loadApiConfig(): ApiConfig {
  const host = process.env.KUBERNETES_SERVICE_HOST
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST unset — proxy needs an in-cluster SA')
  return {
    host,
    port: process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? '443',
    token: fs.readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
    ca: fs.readFileSync(`${SA_DIR}/ca.crt`),
    namespace: fs.readFileSync(`${SA_DIR}/namespace`, 'utf8').trim(),
  }
}

function apiGet(cfg: ApiConfig, pathAndQuery: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: cfg.host,
        port: cfg.port,
        path: pathAndQuery,
        ca: cfg.ca,
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume()
          reject(new Error(`k8s API ${pathAndQuery} → ${res.statusCode}`))
          return
        }
        res.setEncoding('utf8')
        let buf = ''
        res.on('data', (chunk: string) => {
          buf += chunk
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (line.trim()) onLine(line)
          }
        })
        res.on('end', () => {
          if (buf.trim()) onLine(buf)
          resolve()
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
  })
}

const PODS_PATH = (ns: string): string =>
  `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(LABEL_SESSION_ID)}`

/**
 * Seed the index from a list, then stream watch events into it, reconnecting
 * (with a re-list to evict anything missed) on every disconnect. Runs for the
 * proxy's lifetime; never resolves.
 */
export async function startPodWatch(index: PodSessionIndex, cfg = loadApiConfig()): Promise<void> {
  for (;;) {
    try {
      // List → seed. The whole body is one JSON object (a PodList).
      let body = ''
      await apiGet(cfg, `${PODS_PATH(cfg.namespace)}&resourceVersion=0`, (line) => { body += line })
      const list = JSON.parse(body) as { items?: WatchedPod[]; metadata?: { resourceVersion?: string } }
      index.replaceAll(list.items ?? [])
      const rv = list.metadata?.resourceVersion ?? '0'
      console.log(`[proxy] pod-watch: seeded ${index.size} session pod(s)`)

      // Watch → stream newline-delimited events until the connection drops.
      await apiGet(cfg, `${PODS_PATH(cfg.namespace)}&watch=1&resourceVersion=${rv}`, (line) => {
        try {
          index.apply(JSON.parse(line) as PodWatchEvent)
        } catch { /* skip a torn line; the next re-list reconciles */ }
      })
    } catch (err) {
      console.error('[proxy] pod-watch error, retrying:', (err as Error).message)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/**
 * Cache-miss fallback: a brand-new pod's first packet can beat its watch
 * event. Look the pod up directly by IP, populate the index, and return its
 * session (or undefined → the caller fails closed).
 */
export async function fetchSessionByPodIp(
  index: PodSessionIndex,
  ip: string,
  cfg = loadApiConfig(),
): Promise<string | undefined> {
  let body = ''
  await apiGet(
    cfg,
    `${PODS_PATH(cfg.namespace)}&fieldSelector=${encodeURIComponent(`status.podIP=${ip}`)}`,
    (line) => { body += line },
  )
  const list = JSON.parse(body) as { items?: WatchedPod[] }
  for (const pod of list.items ?? []) {
    const sid = podSessionId(pod)
    if (sid && pod.status?.podIP === ip) {
      index.set(ip, sid)
      return sid
    }
  }
  return undefined
}
