import type { NodeDisk, NodeDiskTree } from '@yaac/shared/types'
import { env } from '@yaac/shared/env'
import {
  DISK_APP_NAME,
  LABEL_INSTALL_ID,
  installId,
  k8sNamespace,
  listObjects,
} from '#drivers/k8s/substrate'

/**
 * Each node's disk as its disk pod reads it (cluster/disk-pod.ts), with the
 * floors the full-node guard holds it to (docs/node-local-workspaces.md
 * "A full node"). The floors are the install's settings, absolute sizes;
 * where trees share kubelet's own filesystem on a byo node, kubelet's
 * eviction threshold (10% of the disk, 5% on k3s) is added, so yaac acts
 * before kubelet does. kind's kubelet evicts at 0%.
 */

const GiB = 1024 ** 3
/** One disk pod's answer must arrive within this. */
const ASK_TIMEOUT_MS = 5_000
/** How often the server reads every node's free space. */
const WATCH_INTERVAL_MS = 5_000
/** The trigger a node under its warn floor raises. */
export const DISK_LOW_TRIGGER = 'disk-low' as const

interface PodRow {
  spec?: { nodeName?: string; containers?: Array<{ ports?: Array<{ containerPort?: number }> }> }
  status?: { podIP?: string }
}
interface NodeRow {
  metadata?: { name?: string }
  status?: { nodeInfo?: { kubeletVersion?: string } }
}

/** The disk pod's answer, checked field by field. */
function parseReading(body: unknown): Omit<NodeDisk, 'node' | 'warnBytes' | 'stopBytes'> | null {
  if (typeof body !== 'object' || body === null) return null
  const o = body as Record<string, unknown>
  if (typeof o.totalBytes !== 'number' || typeof o.freeBytes !== 'number' || typeof o.sharesKubeletDisk !== 'boolean') return null
  const trees = Array.isArray(o.trees)
    ? o.trees.flatMap((t: unknown): NodeDiskTree[] => {
      const r = t as Record<string, unknown>
      return typeof r.project === 'string' && typeof r.workspace === 'string' && typeof r.life === 'string' && typeof r.bytes === 'number'
        ? [{ projectId: r.project, workspaceId: r.workspace, life: r.life, bytes: r.bytes }]
        : []
    })
    : undefined
  return {
    totalBytes: o.totalBytes, freeBytes: o.freeBytes, sharesKubeletDisk: o.sharesKubeletDisk,
    ...(trees ? { trees } : {}), ...(o.truncated === true ? { truncated: true } : {}),
  }
}

/** The floors a node's reading is held to. */
function floors(reading: { totalBytes: number; sharesKubeletDisk: boolean }, k3s: boolean): { warnBytes: number; stopBytes: number } {
  // Only a byo install names a storage class for its volumes; kind's
  // kubelet thresholds are zero, so nothing is added there.
  const byo = env.volumeStorageClass !== undefined
  const kubelet = byo && reading.sharesKubeletDisk ? reading.totalBytes * (k3s ? 0.05 : 0.1) : 0
  return { warnBytes: kubelet + env.diskWarnFloorGiB * GiB, stopBytes: kubelet + env.diskStopFloorGiB * GiB }
}

/**
 * Every node's disk, asking each node's disk pod; with `trees`, also the
 * size of every tree on it. A node whose pod cannot be asked is listed with
 * the error, and zeros.
 */
export async function readNodeDisks(opts: { trees: boolean }): Promise<NodeDisk[]> {
  const [nodes, pods] = await Promise.all([
    listObjects<NodeRow>('v1', 'Node', {}),
    listObjects<PodRow>('v1', 'Pod', {
      namespace: k8sNamespace(),
      labelSelector: `app=${DISK_APP_NAME},${LABEL_INSTALL_ID}=${installId()}`,
      fieldSelector: 'status.phase=Running',
    }),
  ])
  return Promise.all(nodes.map(async (n): Promise<NodeDisk> => {
    const node = n.metadata?.name ?? ''
    const k3s = n.status?.nodeInfo?.kubeletVersion?.includes('k3s') ?? false
    const blank = { node, totalBytes: 0, freeBytes: 0, warnBytes: 0, stopBytes: 0, sharesKubeletDisk: false }
    const pod = pods.find((p) => p.spec?.nodeName === node && p.status?.podIP)
    if (!pod) return { ...blank, error: 'no disk pod is running on this node' }
    const port = pod.spec?.containers?.[0]?.ports?.[0]?.containerPort
    const host = pod.status?.podIP?.includes(':') ? `[${pod.status.podIP}]` : pod.status?.podIP
    try {
      const res = await fetch(`http://${host}:${String(port)}/disk${opts.trees ? '?trees=1' : ''}`, {
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`answered ${String(res.status)}`)
      const reading = parseReading(await res.json())
      if (!reading) throw new Error('answered something other than a reading')
      return { node, ...reading, ...floors(reading, k3s) }
    } catch (err) {
      return { ...blank, error: `the disk pod could not be asked: ${err instanceof Error ? err.message : String(err)}` }
    }
  }))
}

/**
 * Read every node's free space every few seconds, and raise the trigger
 * whenever one is under its warn floor, so the guard step looks closer.
 * Returns the stop function.
 */
export function watchNodeDisks(trigger: (source: typeof DISK_LOW_TRIGGER) => void): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    readNodeDisks({ trees: false })
      .then((disks) => { if (disks.some((d) => !d.error && d.freeBytes < d.warnBytes)) trigger(DISK_LOW_TRIGGER) })
      .catch(() => {})
      .finally(() => { busy = false })
  }, WATCH_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
