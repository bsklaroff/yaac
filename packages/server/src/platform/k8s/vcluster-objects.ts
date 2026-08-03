/**
 * The vcluster half of the k8s object layer: the shapes a vcluster's host
 * namespace publishes, the validate-and-map step that turns raw API objects
 * into them, and the one-shot list calls.
 *
 * This is the same job `pods.ts` does for session pods and Jobs, and it lives
 * beside it for the same reason: the informer registry (cluster-cache.ts) and
 * the reconcile snapshot (tick-snapshot.ts) are platform, and they need these
 * shapes without any of the vcluster *lifecycle* — provisioning, sleep/wake,
 * teardown — that features/cluster owns. Reaching up through that feature's
 * barrel for them would drag cluster check and setup into the informer cache.
 *
 * The schemas are shared by both readers on purpose: informer caches see
 * class instances with Date timestamps from list calls and raw JSON from
 * watch events, so the parse has to accept both.
 */
import { z } from 'zod'
import { dataDirHash, kubectlGetJson } from '#platform/k8s/kubectl'
import { LABEL_VCLUSTER_MANAGED_BY } from '#platform/k8s/pods'

/** Ownership + install-scope labels yaac stamps on every vcluster namespace. */
export const LABEL_VCLUSTER = 'yaac.vcluster'
export const LABEL_VCLUSTER_SESSION_ID = 'yaac.vcluster-session-id'
export const LABEL_VCLUSTER_DATA_DIR_HASH = 'yaac.vcluster-data-dir-hash'

export interface VclusterNamespaceInfo {
  /** The vcluster (release) name, `yvc-<sid8>`. */
  name: string
  /** Owning session id. */
  sessionId: string
  /** The dedicated host namespace. */
  namespace: string
  /** Namespace creationTimestamp (ISO) — the orphan-GC grace anchor. */
  creationTimestamp: string
}

/**
 * Raw-object schemas shared by the kubectl lists below and the informer
 * caches (which see class instances with Date timestamps from list calls
 * and raw JSON from watch events — hence the union).
 */
const namespaceObjectSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    creationTimestamp: z.union([z.string(), z.date()]).optional(),
  }),
})

/**
 * Validate+map one raw Namespace object to VclusterNamespaceInfo;
 * null = malformed or not a vcluster namespace (missing ownership labels).
 */
export function mapVclusterNamespaceObject(obj: unknown): VclusterNamespaceInfo | null {
  const res = namespaceObjectSchema.safeParse(obj)
  if (!res.success) return null
  const { name: namespace, labels, creationTimestamp } = res.data.metadata
  const name = labels?.[LABEL_VCLUSTER]
  const sessionId = labels?.[LABEL_VCLUSTER_SESSION_ID]
  if (!name || !sessionId) return null
  return {
    name,
    sessionId,
    namespace,
    creationTimestamp: creationTimestamp instanceof Date
      ? creationTimestamp.toISOString()
      : creationTimestamp ?? '',
  }
}

/** The label selector `listVclusterNamespaces` and its informer share. */
export function vclusterNamespaceSelector(): string {
  return `${LABEL_VCLUSTER},${LABEL_VCLUSTER_DATA_DIR_HASH}=${dataDirHash()}`
}

/**
 * List this install's vcluster host namespaces (one per live vcluster).
 * The namespace is the top-level object — listing it (rather than the
 * Deployment inside it) means a half-created vcluster whose Deployment
 * never landed is still GC'd.
 */
export async function listVclusterNamespaces(): Promise<VclusterNamespaceInfo[]> {
  const list = await kubectlGetJson<{ items: unknown[] }>([
    'get', 'namespaces', '-l', vclusterNamespaceSelector(),
  ])
  return (list?.items ?? []).flatMap((n) => mapVclusterNamespaceObject(n) ?? [])
}

/**
 * A pod inside a vcluster's host namespace. Attribution reads the IP; claim
 * validation (redirect-claims.ts) reads both, since a claim may only name
 * pod IPs the SYNCER stamped as belonging to that vcluster.
 */
export interface VclusterPod {
  name: string
  podIP?: string
  labels: Record<string, string>
}

const vclusterPodObjectSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
  }),
  status: z.object({ podIP: z.string().optional() }).optional(),
})

export function mapVclusterPodObject(obj: unknown): VclusterPod | null {
  const res = vclusterPodObjectSchema.safeParse(obj)
  if (!res.success) return null
  const podIP = res.data.status?.podIP
  return {
    name: res.data.metadata.name,
    ...(podIP ? { podIP } : {}),
    labels: res.data.metadata.labels ?? {},
  }
}

/** All pods in a vcluster's host namespace (informer-cache fallback). */
export async function listVclusterPods(namespace: string): Promise<VclusterPod[]> {
  const list = await kubectlGetJson<{ items: unknown[] }>(['get', 'pods', '-n', namespace])
  return (list?.items ?? []).flatMap((p) => mapVclusterPodObject(p) ?? [])
}

/** A syncer-managed Service in a vcluster's host namespace. */
export interface VclusterService {
  name: string
  labels: Record<string, string>
}

const vclusterServiceObjectSchema = z.object({
  metadata: z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
  }),
})

export function mapVclusterServiceObject(obj: unknown): VclusterService | null {
  const res = vclusterServiceObjectSchema.safeParse(obj)
  if (!res.success) return null
  return { name: res.data.metadata.name, labels: res.data.metadata.labels ?? {} }
}

/**
 * A ConfigMap inside a vcluster's host namespace. Only the redirect-claim
 * ones are read (picked out by name — isClaimConfigMapName), so this carries
 * just their payload.
 */
export interface VclusterConfigMap {
  name: string
  data: Record<string, string>
}

const vclusterConfigMapObjectSchema = z.object({
  metadata: z.object({ name: z.string().min(1) }),
  data: z.record(z.string(), z.string()).optional(),
})

export function mapVclusterConfigMapObject(obj: unknown): VclusterConfigMap | null {
  const res = vclusterConfigMapObjectSchema.safeParse(obj)
  if (!res.success) return null
  return { name: res.data.metadata.name, data: res.data.data ?? {} }
}

/**
 * ConfigMaps in a vcluster's host namespace (informer-cache fallback). The
 * synced redirect claims an inner install's claim-mode netd publishes are
 * among them, picked out by name (redirect-claims.ts).
 */
export async function listVclusterConfigMaps(
  namespace: string,
): Promise<VclusterConfigMap[]> {
  const list = await kubectlGetJson<{ items: unknown[] }>([
    'get', 'configmaps', '-n', namespace,
  ])
  return (list?.items ?? []).flatMap((cm) => mapVclusterConfigMapObject(cm) ?? [])
}

/**
 * The syncer-managed Services in a vcluster's host namespace
 * (informer-cache fallback).
 */
export async function listVclusterServices(
  namespace: string,
  vcName: string,
): Promise<VclusterService[]> {
  const list = await kubectlGetJson<{ items: unknown[] }>([
    'get', 'services', '-n', namespace, '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${vcName}`,
  ])
  return (list?.items ?? []).flatMap((s) => mapVclusterServiceObject(s) ?? [])
}
