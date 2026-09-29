/**
 * GC of each node's containerd image store — the unpacked copy of the main
 * registry's images, and by far the largest of the stores an image passes
 * through: registries hold compressed blobs, containerd holds every image
 * it ever pulled as overlayfs snapshots (measured: 110 GB of snapshots
 * beside 1 GB of blobs, 107 of 129 images referenced by no container).
 *
 * The kubelet's own image GC is no backstop: kind disables it
 * (`imageGCHighThresholdPercent: 100`), and a cluster yaac did not create
 * may configure it any way at all.
 *
 * Policy: a node drops a yaac content-hash generation once the MAIN
 * REGISTRY no longer holds its tag and no workload references it. That
 * makes the registry's retention (main-registry-gc.ts) the one policy for
 * both stores — what it keeps as current, live or rollback stays warm on
 * the node, so a worktree create never pays a multi-GB pull for an image
 * the install still wants — and it means nothing is ever dropped that a
 * pod could still pull by name.
 *
 * Scoped to refs under the main registry host with a 16-hex tag in a
 * `yaac-*` repo, the same shape the registry retention retires: the
 * digest-pinned mirrors, the kind node's own preloaded images and anything
 * a worktree's nested engine or a project registry put there are never
 * candidates.
 *
 * The node is read from `node.status.images`, which the kubelet caps at
 * its 50 largest images — the ones worth reclaiming; smaller ones surface
 * as the big ones go. The removal runs on the node, through its own
 * `crictl` (entered via PID 1's mount namespace, as the gVisor installer
 * reaches the node's systemctl), with a long timeout: crictl's default is
 * 2 s, and a multi-GB delete under it reports DeadlineExceeded and frees
 * almost nothing.
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

/** `app` label of the prune pods; with the hash label, what the next
 *  pass's stray delete selects. */
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
 * The prune pod for one node: root and privileged with the host PID
 * namespace — there is no narrower way to reach the node's CRI socket
 * through the node's own client — pinned by `nodeName`, tolerating every
 * taint.
 *
 * Its image is the digest-pinned UPSTREAM registry:2 (busybox, so it
 * carries nsenter), never a tag in the main registry. A pod this powerful
 * is node root, and every mutable tag in that registry is writable by a
 * builder pod (docs/trust-split-builds.md "Open risk"); a digest ref is
 * not something an overwritten tag can redirect. The main registry's
 * hosts writer runs the same ref on every node, so it is already there.
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
 * One pass over every node: remove each yaac generation the registry has
 * retired and no workload references (`inUse`, `repo:tag`). Best-effort
 * throughout — a failure costs disk, never a pod. An image goes only on
 * the registry's own 404 for every one of its tags: a timeout or an error
 * answer is not evidence of retirement, and the pass runs moments after the
 * collect restarted the registry, when slow answers are likeliest.
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
