import crypto from 'node:crypto'
import type { V1Pod } from '@kubernetes/client-node'
import { applyObject, deleteObject, deleteObjects, k8sNamespace, listObjects, readObject } from './api'
import { getCoreApi } from './client'
import { followPod, watchPodsBy } from './pod-wait'
import { PRIORITY_CLASS_INFRA } from './priority-classes'

/**
 * One-shot pods: run a pod to a terminal phase and collect its logs, alone
 * or once on every node.
 */

interface RunPodOptions {
  /** Deadline for the pod to reach a terminal phase. */
  timeoutMs: number
}

interface PodRunResult {
  /**
   * Terminal phase; `Deleted` if the pod disappeared while waiting; or the
   * last phase seen when the deadline passed.
   */
  phase: string
  /** Pod logs, best-effort ('' when unavailable). */
  logs: string
  /** The pod's uid, once it has been seen; names its events unambiguously
   *  when a later run reuses the pod name. */
  uid?: string
}

/**
 * Run a one-shot pod (restartPolicy: Never) to completion: delete any stray
 * pod of the same name, apply, follow it to a terminal phase, fetch logs,
 * and always delete the pod afterwards. A Failed pod returns at once. The
 * caller judges the result.
 */
export async function runPodToCompletion(
  manifest: Record<string, unknown>,
  opts: RunPodOptions,
): Promise<PodRunResult> {
  const { name, namespace } = (manifest as { metadata: { name: string; namespace: string } }).metadata
  const ref = { apiVersion: 'v1', kind: 'Pod', name, namespace }
  await deleteObject(ref, { wait: true })
  try {
    await applyObject(manifest)
    let phase = 'Pending'
    let uid: string | undefined
    await followPod({
      listPods: async () => {
        const pod = await readObject<V1Pod>(ref)
        return { resourceVersion: pod?.metadata?.resourceVersion, pods: pod ? [pod] : [] }
      },
      watchPods: watchPodsBy(namespace, { fieldSelector: `metadata.name=${name}` }),
    }, (pod) => {
      // Something else deleted the pod; it will never finish.
      if (!pod) return (phase = 'Deleted')
      uid = pod.metadata?.uid ?? uid
      phase = pod.status?.phase ?? 'Unknown'
      return phase === 'Succeeded' || phase === 'Failed' ? phase : undefined
    }, opts.timeoutMs)
    const logs = await getCoreApi().readNamespacedPodLog({ name, namespace }).catch(() => '')
    return { phase, logs, ...(uid ? { uid } : {}) }
  } finally {
    await deleteObject(ref).catch(() => { /* best-effort cleanup */ })
  }
}

/** A node as `runOnEachNode` hands it to the caller. */
interface ClusterNode {
  name: string
  /** `status.images[].names`: the kubelet lists its 50 largest images. */
  images: string[][]
}

/** What one node's pod runs. */
interface NodePod {
  image: string
  command: string[]
  /** Container fields beyond image and command (securityContext, mounts). */
  container?: Record<string, unknown>
  /** Pod spec fields beyond the pinning (volumes, hostNetwork, hostPID). */
  spec?: Record<string, unknown>
}

interface NodePodRun extends PodRunResult {
  node: string
  /** The pod's name, for an error message. */
  pod: string
}

/**
 * Run a trusted one-shot pod on every node, one node at a time, for work on
 * the node's own files or runtime. Each pod is pinned with `nodeName`, runs
 * on runc, and tolerates every taint: `nodeName` skips the scheduler, but a
 * `NoExecute` taint would still evict it, and tainted workspace nodes need
 * the work most. Pods a crashed run left behind are deleted by `labels`
 * first, since names carry a per-run suffix. `pod` may return null to skip
 * a node.
 */
export async function runOnEachNode(opts: {
  /** Pod names are `<name>-<node index>-<run id>`. */
  name: string
  namespace?: string
  labels: Record<string, string>
  timeoutMs: number
  pod: (node: ClusterNode) => NodePod | null | Promise<NodePod | null>
}): Promise<NodePodRun[]> {
  const namespace = opts.namespace ?? k8sNamespace()
  const selector = Object.entries(opts.labels).map(([k, v]) => `${k}=${v}`).join(',')
  // No wait: a leftover stuck Terminating on a NotReady node would block
  // here forever, and run ids keep the new pods' names apart anyway.
  await deleteObjects('v1', 'Pod', { namespace, labelSelector: selector })
  const nodes = await listObjects<
    { metadata: { name: string }; status?: { images?: Array<{ names?: string[] }> } }
  >('v1', 'Node')
  const runId = crypto.randomBytes(4).toString('hex')
  const runs: NodePodRun[] = []
  for (const [i, item] of nodes.entries()) {
    const node = {
      name: item.metadata.name,
      images: (item.status?.images ?? []).map((img) => img.names ?? []),
    }
    const pod = await opts.pod(node)
    if (!pod) continue
    const name = `${opts.name}-${String(i)}-${runId}`
    const result = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace, labels: opts.labels },
      spec: {
        nodeName: node.name,
        restartPolicy: 'Never',
        tolerations: [{ operator: 'Exists' }],
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        priorityClassName: PRIORITY_CLASS_INFRA,
        ...pod.spec,
        containers: [{
          name: 'run',
          image: pod.image,
          imagePullPolicy: 'IfNotPresent',
          command: pod.command,
          ...pod.container,
        }],
      },
    }, { timeoutMs: opts.timeoutMs })
    runs.push({ ...result, node: node.name, pod: name })
  }
  return runs
}

