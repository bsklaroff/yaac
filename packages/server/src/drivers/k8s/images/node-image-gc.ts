/**
 * GC of each node's containerd image store, which keeps every pulled image
 * unpacked and is by far the largest image store. The kubelet's image GC
 * does not help: kind disables it, and other clusters configure it
 * arbitrarily. See docs/image-gc.md.
 *
 * A node drops a yaac image once the main registry no longer has its tag
 * and no workload uses it, so the registry's retention (main-registry-gc.ts)
 * decides for both stores. Only `yaac-*` refs with a 16-hex tag under the
 * main registry host are candidates.
 *
 * Images come from `node.status.images` (the kubelet lists the 50 largest).
 * Removal runs the node's own `crictl` with a long timeout; its 2s default
 * makes large deletes fail.
 */
import crypto from 'node:crypto'
import {
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { REGISTRY_UPSTREAM_IMAGE } from '#drivers/k8s/cluster'
import { registryHost, registryTagState } from '#drivers/k8s/container'
import { serverLog } from '#log'
import { LABEL_SWEEP_DATA_DIR_HASH } from './node-local-sweep'

/** `app` label of the prune pods, used to delete strays. */
const NODE_IMAGE_GC_APP_LABEL = 'yaac-node-image-gc'

/** Deadline for one node's removals — each can take minutes. */
const NODE_IMAGE_GC_TIMEOUT_MS = 15 * 60_000

/** The `repo:tag` of a main-registry content-hash generation, or null. */
export function registryGeneration(ref: string): string | null {
  const prefix = `${registryHost()}/`
  if (!ref.startsWith(prefix)) return null
  const tag = ref.slice(prefix.length)
  return /^yaac-[a-z0-9._/-]*:[0-9a-f]{16}$/.test(tag) ? tag : null
}

interface RawNodeList {
  items: Array<{
    metadata: { name: string }
    status?: { images?: Array<{ names?: string[] }> }
  }>
}

/**
 * The prune pod for one node: privileged root with host PID (the only way
 * to reach the node's CRI through its own client), pinned by `nodeName`,
 * tolerating every taint.
 *
 * Uses the digest-pinned upstream registry:2 image (busybox, has nsenter)
 * rather than a main-registry tag, so an overwritten tag can never run as
 * node root. It is already on every node.
 */
function buildNodeImageGcPodManifest(params: {
  nodeName: string
  refs: string[]
  runId: string
  nodeIndex: number
}): Record<string, unknown> {
  const script = [
    'for ref in "$@"; do',
    '  if nsenter -t 1 -m -- crictl -t 10m rmi "$ref" >/dev/null; then echo "removed $ref"; fi',
    'done',
  ].join('\n')
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `yaac-node-image-gc-${params.nodeIndex}-${params.runId}`,
      namespace: k8sNamespace(),
      labels: { app: NODE_IMAGE_GC_APP_LABEL, [LABEL_SWEEP_DATA_DIR_HASH]: dataDirHash() },
    },
    spec: {
      nodeName: params.nodeName,
      restartPolicy: 'Never',
      hostPID: true,
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'prune',
        image: REGISTRY_UPSTREAM_IMAGE,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', script, '--', ...params.refs],
        securityContext: { privileged: true, runAsUser: 0 },
      }],
    },
  }
}

/**
 * Remove, on every node, each yaac image the registry has retired and no
 * workload uses (`inUse`, as `repo:tag`). Best-effort. An image is removed
 * only if the registry answers 404 for all its tags; errors and timeouts
 * do not count, since the registry has just restarted after a collect.
 */
export async function pruneNodeImages(inUse: ReadonlySet<string>): Promise<void> {
  const selector = `app=${NODE_IMAGE_GC_APP_LABEL},${LABEL_SWEEP_DATA_DIR_HASH}=${dataDirHash()}`
  await kubectlWithRetry([
    'delete', 'pods', '-n', k8sNamespace(), '-l', selector, '--ignore-not-found', '--wait=false',
  ], { maxAttempts: 1 }).catch(() => { /* a stray only costs a pod */ })

  const nodes = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [nodeIndex, node] of (nodes?.items ?? []).entries()) {
    const refs: string[] = []
    for (const { names = [] } of node.status?.images ?? []) {
      const generations = names.map(registryGeneration).filter((g): g is string => g !== null)
      if (generations.length === 0 || generations.some((g) => inUse.has(g))) continue
      const states = await Promise.all(generations.map(registryTagState))
      if (states.some((state) => state !== 'absent')) continue
      refs.push(`${registryHost()}/${generations[0]}`)
    }
    if (refs.length === 0) continue
    const { phase, logs } = await runPodToCompletion(
      buildNodeImageGcPodManifest({ nodeName: node.metadata.name, refs, runId, nodeIndex }),
      { timeoutMs: NODE_IMAGE_GC_TIMEOUT_MS, pollMs: 2000 },
    )
    const count = logs.split('\n').filter((l) => l.startsWith('removed ')).length
    serverLog(`[node-image-gc] ${node.metadata.name}: removed ${count} of ${refs.length} retired image(s)`
      + (phase === 'Succeeded' ? '' : ` (pod ${phase})`))
  }
}
