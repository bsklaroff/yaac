import { statfs } from 'node:fs/promises'
import { MAIN_REGISTRY_APP_LABEL, REGISTRY_APP_LABEL } from '#drivers/k8s/cluster'
import {
  CHECKOUTS_CLAIM_NAME,
  GLOBAL_CLAIM_NAME,
  GVISOR_NODE_LABEL,
  GVISOR_PENDING_TAINT,
  LABEL_PREWARMED,
  LABEL_PROJECT_ID,
  LABEL_ROLE,
  LABEL_WORKSPACE_ID,
  NETD_APP_NAME,
  NPM_CACHE_APP_NAME,
  POD_GLOBAL_ROOT,
  POD_SERVER_LOCAL_ROOT,
  PROXY_APP_NAME,
  ROLE_BUILDER,
  SERVER_APP_NAME,
  SERVER_FRONT_APP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  WORKSPACE_POOL_KEY,
  apiStatus,
  k8sErrorSummary,
  k8sNamespace,
  listObjects,
  readPath,
  type NodeTaint,
} from '#drivers/k8s/substrate'
import type { SubstrateUsage } from '#drivers/contract'
import type {
  ComponentUsage,
  NodeRole,
  NodeUsage,
  ResourceUse,
  VolumeUsage,
  WorkspaceResourceUse,
} from '@yaac/shared/types'

/**
 * `WorkspaceDriver.resourceUsage` for the cluster (docs/server-health.md).
 * Reads only what Kubernetes already collects: node, pod and claim objects,
 * and each node's kubelet Summary through the API server's node proxy.
 *
 * Pods in the install namespace are yaac's, classified by their labels into
 * the overlay's components; whatever else a node runs is "Kubernetes system
 * and other".
 */

interface ResourceList {
  cpu?: string
  memory?: string
  storage?: string
}

interface NodeObject {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: { taints?: NodeTaint[] }
  status?: {
    capacity?: ResourceList
    allocatable?: ResourceList
    conditions?: Array<{ type: string; status: string }>
  }
}

interface PodObject {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec?: {
    nodeName?: string
    containers?: Array<{ resources?: { requests?: ResourceList; limits?: ResourceList } }>
    volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }>
  }
}

interface PvcObject {
  metadata: { name: string }
  status?: { capacity?: ResourceList }
}

interface FsStats {
  usedBytes?: number
  capacityBytes?: number
  availableBytes?: number
}

/** The kubelet's Summary (`/stats/summary`), the fields read here. */
interface Summary {
  node: {
    cpu?: { usageNanoCores?: number }
    memory?: { time?: string; workingSetBytes?: number }
    swap?: { swapUsageBytes?: number; swapAvailableBytes?: number }
    fs?: FsStats
    runtime?: { imageFs?: FsStats }
  }
  pods?: Array<{
    podRef: { name: string; namespace: string }
    memory?: { workingSetBytes?: number }
    containers?: Array<{ cpu?: { usageNanoCores?: number }; memory?: { workingSetBytes?: number } }>
    volume?: Array<FsStats & { pvcRef?: { name: string; namespace: string } }>
    'ephemeral-storage'?: FsStats
  }>
}

type PodStats = NonNullable<Summary['pods']>[number]

const UNITS: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
}

/** A Kubernetes quantity (`500m`, `16Gi`, `1e3`) as a number; 0 if absent
 *  or malformed. */
function parseQuantity(text: string | undefined): number {
  const m = /^([+-]?[\d.]+(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(text ?? '')
  return m && m[2] in UNITS ? Number(m[1]) * UNITS[m[2]] : 0
}

/** What the server says when a node's stats are refused. */
const NODE_PROXY_DENIED = 'the server may not read node stats yet; '
  + '`yaac cluster install` grants it (get on nodes/proxy)'

/**
 * How long one node's Summary may take. The API server answers for an
 * unreachable kubelet only after its own dial timeout, so a node that went
 * away would otherwise hold every read for that long. A missed read is
 * retried by the next one anyway.
 */
const SUMMARY_TIMEOUT_MS = 5_000

const ZERO: ResourceUse = { cpuCores: 0, memoryBytes: 0 }

function add(a: ResourceUse, b: ResourceUse): ResourceUse {
  return {
    cpuCores: a.cpuCores + b.cpuCores,
    memoryBytes: a.memoryBytes + b.memoryBytes,
  }
}

/** A pod's use: its containers' CPU, and its pod cgroup's memory until
 *  that reads 0 (docs/server-health.md). */
function podUse(stats: PodStats): ResourceUse {
  const containers = stats.containers ?? []
  return {
    cpuCores: containers.reduce((sum, c) => sum + (c.cpu?.usageNanoCores ?? 0), 0) / 1e9,
    memoryBytes: stats.memory?.workingSetBytes
      || containers.reduce((sum, c) => sum + (c.memory?.workingSetBytes ?? 0), 0),
  }
}

function nodeRole(node: NodeObject): NodeRole {
  const labels = node.metadata.labels ?? {}
  const taints = node.spec?.taints ?? []
  if (labels[WORKSPACE_POOL_KEY] === 'false') return 'infrastructure'
  if (labels[GVISOR_NODE_LABEL] !== 'true' || taints.some((t) => t.key === GVISOR_PENDING_TAINT)) {
    return 'gvisor-pending'
  }
  return taints.some((t) => t.key === WORKSPACE_POOL_KEY) ? 'workspaces' : 'both'
}

/** The conditions that are not as they should be. */
function badConditions(node: NodeObject): string[] {
  return (node.status?.conditions ?? []).flatMap(({ type, status }) => {
    if (type === 'Ready') return status === 'True' ? [] : ['NotReady']
    return status === 'True' ? [type] : []
  })
}

/** A volume merged with others on one backing store: the checkouts claim is
 *  a second mount of the global one (storage-constants.ts). */
function claimKey(claim: string): string {
  return claim === CHECKOUTS_CLAIM_NAME ? GLOBAL_CLAIM_NAME : claim
}

/** The claims the server mounts, which it can `statfs` itself when the
 *  kubelet reports no usage for them (hostPath and local-path volumes). */
const SERVER_MOUNTS: Record<string, string> = {
  [GLOBAL_CLAIM_NAME]: POD_GLOBAL_ROOT,
  [SERVER_LOCAL_CLAIM_NAME]: POD_SERVER_LOCAL_ROOT,
}

async function statfsUsage(dir: string): Promise<FsStats | null> {
  try {
    const st = await statfs(dir)
    return { usedBytes: (st.blocks - st.bfree) * st.bsize, capacityBytes: st.blocks * st.bsize }
  } catch {
    return null
  }
}

/** One fixed component and the pods it sums, in the overlay's order. */
interface Bucket {
  key: string
  label: string
  /** Report how many pods it sums. */
  counted?: boolean
  pods: Array<{ pod: PodObject; stats: PodStats | undefined }>
}

/** Which component an install-namespace pod belongs to; undefined for a
 *  workspace. */
function bucketKey(pod: PodObject): string | undefined {
  const labels = pod.metadata.labels ?? {}
  if (labels[LABEL_WORKSPACE_ID] !== undefined) {
    return labels[LABEL_PREWARMED] === undefined ? undefined : 'spares'
  }
  if (labels[LABEL_ROLE] === ROLE_BUILDER) return 'builders'
  switch (labels.app) {
    case SERVER_APP_NAME: return 'server'
    case MAIN_REGISTRY_APP_LABEL: return 'main-registry'
    case REGISTRY_APP_LABEL: return 'project-registries'
    case NPM_CACHE_APP_NAME: return 'npm-cache'
    case PROXY_APP_NAME: return 'proxy'
    case NETD_APP_NAME: return 'netd'
    case SERVER_FRONT_APP_NAME: return 'server-front'
    // The one-shot GC and sweep pods, and the gVisor installer.
    default: return 'maintenance'
  }
}

function emptyBuckets(): Bucket[] {
  return [
    { key: 'server', label: 'yaac server', pods: [] },
    { key: 'main-registry', label: 'main registry', pods: [] },
    { key: 'project-registries', label: 'project registries', counted: true, pods: [] },
    { key: 'npm-cache', label: 'npm cache', pods: [] },
    { key: 'proxy', label: 'egress proxy', pods: [] },
    { key: 'netd', label: 'netd', counted: true, pods: [] },
    { key: 'server-front', label: 'server front', pods: [] },
    { key: 'builders', label: 'image builders', counted: true, pods: [] },
    { key: 'spares', label: 'prewarmed spares', counted: true, pods: [] },
    { key: 'maintenance', label: 'maintenance pods', counted: true, pods: [] },
  ]
}

/** See `WorkspaceDriver.resourceUsage`. */
export async function k8sUsage(opts: { full: boolean }): Promise<SubstrateUsage> {
  const ns = k8sNamespace()
  const [nodeObjects, pods, pvcs, scheduledPods] = await Promise.all([
    listObjects<NodeObject>('v1', 'Node'),
    // Not the one-shot pods that finished, which the kubelet keeps for a while.
    listObjects<PodObject>('v1', 'Pod', { namespace: ns, fieldSelector: 'status.phase=Running' }),
    opts.full ? listObjects<PvcObject>('v1', 'PersistentVolumeClaim', { namespace: ns }) : [],
    opts.full
      ? listObjects<PodObject>('v1', 'Pod', { fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' })
      : [],
  ])
  const summaries = await Promise.all(nodeObjects.map(async (node) => {
    // Its kubelet is not answering the API server either; do not wait on it.
    if (badConditions(node).includes('NotReady')) return { error: 'NotReady; stats not read' }
    try {
      const summary = await readPath<Summary>(
        `/api/v1/nodes/${encodeURIComponent(node.metadata.name)}/proxy/stats/summary`,
        opts.full ? {} : { only_cpu_and_memory: 'true' },
        SUMMARY_TIMEOUT_MS,
      )
      return { summary }
    } catch (err) {
      return { error: apiStatus(err) === 403 ? NODE_PROXY_DENIED : k8sErrorSummary(err) }
    }
  }))

  const statsByPod = new Map<string, PodStats>()
  const volumeStats = new Map<string, FsStats>()
  for (const { summary } of summaries) {
    for (const stats of summary?.pods ?? []) {
      if (stats.podRef.namespace !== ns) continue
      statsByPod.set(stats.podRef.name, stats)
      for (const v of stats.volume ?? []) {
        if (v.pvcRef?.namespace === ns && v.usedBytes !== undefined) volumeStats.set(claimKey(v.pvcRef.name), v)
      }
    }
  }

  const nodes = nodeObjects.map((node, i): NodeUsage => {
    const { summary, error } = summaries[i]
    const s = summary?.node
    return {
      name: node.metadata.name,
      role: nodeRole(node),
      cpuCores: (s?.cpu?.usageNanoCores ?? 0) / 1e9,
      cpuCapacityCores: parseQuantity(node.status?.capacity?.cpu),
      memoryBytes: s?.memory?.workingSetBytes ?? 0,
      memoryCapacityBytes: parseQuantity(node.status?.capacity?.memory),
      swapBytes: s?.swap?.swapUsageBytes ?? 0,
      conditions: badConditions(node),
      sampledAt: s?.memory?.time ? Date.parse(s.memory.time) : null,
      ...(error !== undefined ? { error } : {}),
    }
  })

  const buckets = emptyBuckets()
  const workspaces: Record<string, WorkspaceResourceUse> = {}
  for (const pod of pods) {
    const stats = statsByPod.get(pod.metadata.name)
    const key = bucketKey(pod)
    if (key !== undefined) {
      buckets.find((b) => b.key === key)?.pods.push({ pod, stats })
      continue
    }
    if (!stats) continue
    const limits = (pod.spec?.containers ?? []).map((c) => c.resources?.limits?.memory).filter(Boolean)
    const ephemeral = stats['ephemeral-storage']?.usedBytes
    workspaces[pod.metadata.labels?.[LABEL_WORKSPACE_ID] ?? ''] = {
      ...podUse(stats),
      memoryLimitBytes: limits.length > 0 ? limits.reduce((sum, q) => sum + parseQuantity(q), 0) : null,
      ephemeralStorageBytes: opts.full && ephemeral !== undefined ? ephemeral : null,
      ...(pod.spec?.nodeName ? { node: pod.spec.nodeName } : {}),
    }
  }

  // Each claim is listed once, under the first component that mounts it.
  const claimNames = [...new Set(pvcs.map((p) => claimKey(p.metadata.name)))]
  const mounted = await Promise.all(claimNames.map(async (claim) => {
    const reported = volumeStats.get(claim)
    const local = reported || !(claim in SERVER_MOUNTS) ? null : await statfsUsage(SERVER_MOUNTS[claim])
    const pvc = pvcs.find((p) => p.metadata.name === claim)
    const capacity = reported?.capacityBytes ?? local?.capacityBytes ?? parseQuantity(pvc?.status?.capacity?.storage)
    return [claim, {
      name: claim,
      usedBytes: reported?.usedBytes ?? local?.usedBytes ?? null,
      capacityBytes: capacity || null,
    }] as const
  }))
  const volumes = new Map<string, VolumeUsage>(mounted)
  const owned = new Set<string>()
  const volumesOf = (members: PodObject[]): VolumeUsage[] => members
    .flatMap((p) => p.spec?.volumes ?? [])
    .map((v) => v.persistentVolumeClaim?.claimName)
    .filter((c): c is string => c !== undefined)
    .map(claimKey)
    .filter((c) => volumes.has(c) && !owned.has(c) && owned.add(c))
    .map((c) => volumes.get(c) as VolumeUsage)

  const sumOf = (members: Bucket['pods']): ResourceUse =>
    members.reduce((sum, { stats }) => (stats ? add(sum, podUse(stats)) : sum), ZERO)
  const components: ComponentUsage[] = buckets.filter((b) => b.pods.length > 0).map((b) => {
    const component: ComponentUsage = {
      key: b.key,
      label: b.label,
      ...sumOf(b.pods),
      ...(b.counted ? { count: b.pods.length } : {}),
      volumes: b.key === 'project-registries' ? [] : volumesOf(b.pods.map(({ pod }) => pod)),
    }
    if (b.key !== 'project-registries') return component
    const byProject = new Map<string, Bucket['pods']>()
    for (const member of b.pods) {
      const projectId = member.pod.metadata.labels?.[LABEL_PROJECT_ID] ?? ''
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), member])
    }
    return {
      ...component,
      children: [...byProject].map(([projectId, members]) => ({
        key: `project-registry:${projectId}`,
        label: projectId,
        projectId,
        ...sumOf(members),
        volumes: volumesOf(members.map(({ pod }) => pod)),
      })),
    }
  })

  // Totals cover the nodes that answered, capacity included, so a missing
  // node never reads as an idle one.
  const live = nodes.filter((n) => n.error === undefined)
  const nodeTotal = live.reduce<ResourceUse>((sum, n) => add(sum, n), ZERO)
  const yaacTotal = [...statsByPod.values()].reduce<ResourceUse>((sum, s) => add(sum, podUse(s)), ZERO)
  components.push({
    key: 'system',
    label: 'Kubernetes system and other',
    cpuCores: Math.max(0, nodeTotal.cpuCores - yaacTotal.cpuCores),
    memoryBytes: Math.max(0, nodeTotal.memoryBytes - yaacTotal.memoryBytes),
    volumes: [],
  })

  const disks: VolumeUsage[] = []
  for (const [i, node] of opts.full ? nodes.entries() : []) {
    const s = summaries[i].summary?.node
    const fsVolume = (name: string, fs: FsStats | undefined): VolumeUsage[] => fs?.capacityBytes
      ? [{ name: `${node.name} ${name}`, usedBytes: fs.usedBytes ?? null, capacityBytes: fs.capacityBytes }]
      : []
    const image = s?.runtime?.imageFs
    // On many nodes the image store is a directory of the root filesystem.
    const sameFs = image?.capacityBytes === s?.fs?.capacityBytes && image?.availableBytes === s?.fs?.availableBytes
    disks.push(...fsVolume('root', s?.fs), ...(sameFs ? [] : fsVolume('images', image)))
  }
  disks.push(...volumes.values())

  const swapCapacityBytes = summaries.reduce((sum, { summary }) =>
    sum + (summary?.node.swap?.swapUsageBytes ?? 0) + (summary?.node.swap?.swapAvailableBytes ?? 0), 0)
  const requests = scheduledPods.filter((p) => p.spec?.nodeName)
    .flatMap((p) => p.spec?.containers ?? [])
    .map((c) => c.resources?.requests ?? {})
  return {
    totals: {
      ...nodeTotal,
      swapBytes: live.reduce((sum, n) => sum + n.swapBytes, 0),
      cpuCapacityCores: live.reduce((sum, n) => sum + n.cpuCapacityCores, 0),
      memoryCapacityBytes: live.reduce((sum, n) => sum + n.memoryCapacityBytes, 0),
      swapCapacityBytes,
      disks,
      ...(opts.full
        ? {
          scheduled: {
            cpuRequestCores: requests.reduce((sum, r) => sum + parseQuantity(r.cpu), 0),
            cpuAllocatableCores: nodeObjects.reduce((sum, n) => sum + parseQuantity(n.status?.allocatable?.cpu), 0),
            memoryRequestBytes: requests.reduce((sum, r) => sum + parseQuantity(r.memory), 0),
            memoryAllocatableBytes: nodeObjects.reduce((sum, n) => sum + parseQuantity(n.status?.allocatable?.memory), 0),
          },
        }
        : {}),
    },
    nodes,
    components,
    workspaces,
  }
}
