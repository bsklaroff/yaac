import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  dataDirHash,
  execFileAsync,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#platform/k8s/kubectl'
import { LABEL_PROJECT, LABEL_SESSION_ID, runPodToCompletion } from '#platform/k8s/pods'
import { createKeyedMutex } from '#platform/keyed-mutex'
import { pushImageToRegistry, registryHasTag, registryRef } from '#features/cluster/registry'
import { imageExists } from '#platform/container/runtime'
import { projectDir } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'

/** `app` label value shared by every per-project registry pod. */
export const REGISTRY_APP_LABEL = 'yaac-registry'
/**
 * GC scope label: ties registry objects to this yaac install without
 * making them visible to the session reaper/list paths (which filter on
 * `yaac.data-dir-hash` + `yaac.session-id`).
 */
export const LABEL_REGISTRY_DATA_DIR_HASH = 'yaac.registry-data-dir-hash'
/**
 * Marker label on the one-shot node-write pods (hosts writer / cleanup),
 * value = the pod's kind. Distinguishes them from the registry
 * Deployment's pod, which carries the same registry labels — the stray
 * sweep in `writeNodeRegistryHostsToml` selects on this label's existence
 * so it can never delete the registry itself.
 */
export const LABEL_NODE_WRITE = 'yaac.node-write'
/**
 * In-cluster port of the per-project registry. Deliberately not 443/80:
 * Cilium redirects those to the proxy, whereas 5000 rides the per-project
 * sessions NetworkPolicy straight to the registry, un-MITM'd.
 */
export const PROJECT_REGISTRY_PORT = 5000

/**
 * Upstream registry:2 pinned by its multi-arch index digest — the same
 * image the main local registry runs. Push-and-serve only: no
 * pull-through, no sync, no config beyond storage (nested image pulls go
 * through the MITM proxy instead).
 */
export const REGISTRY_IMAGE_DIGEST =
  'sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'
export const REGISTRY_UPSTREAM_IMAGE = `docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`
/** Local mirror tag; the digest slice keeps it stable and content-keyed. */
export const REGISTRY_MIRROR_TAG = `yaac-registry2:${REGISTRY_IMAGE_DIGEST.slice(7, 19)}`

/**
 * Deployment/Service name for a project's registry:
 * `yaac-reg-<safeSlug≤21>-<hash8>`. The hash spans the data dir + the
 * full slug, so truncated slugs stay unique and coexisting installs
 * sharing a namespace cannot collide. Total length stays well under the
 * 63-char DNS-label cap.
 */
export function projectRegistryName(projectSlug: string): string {
  const safeSlug = projectSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 21)
  const hash8 = crypto.createHash('sha256')
    .update(`${dataDirHash()}/${projectSlug}`)
    .digest('hex')
    .slice(0, 8)
  return `yaac-reg-${safeSlug}-${hash8}`.replace(/--+/g, '-')
}

/**
 * The in-cluster service-DNS name of the registry. A FULL `.svc.cluster.local`
 * FQDN, not the `.svc` shorthand: sessions resolve it through the proxy's
 * split-horizon DNS, which forwards ONLY `.cluster.local` to CoreDNS (a bare
 * `.svc` would be sinkholed, since CoreDNS forwards anything outside its zone
 * to the remote resolver — a DNS-exfil channel). The node's containerd matches
 * it via the hosts.toml this module writes (it never DNS-resolves it).
 */
export function projectRegistryHostname(projectSlug: string): string {
  return `${projectRegistryName(projectSlug)}.${k8sNamespace()}.svc.cluster.local`
}

/** `projectRegistryHostname` with the registry port (the image-ref host). */
export function projectRegistryHost(projectSlug: string): string {
  return `${projectRegistryHostname(projectSlug)}:${PROJECT_REGISTRY_PORT}`
}

/**
 * Node-local hostPath backing the registry's storage. Node-local (not
 * under the data dir) like the shared image store: registry blob layouts
 * are hostile to virtiofs, and loss on cluster recreate only costs
 * re-pushes. Known growth tradeoff: stale content-hash tags accumulate
 * until project removal or cluster recreate (registry:2 GC wants a
 * quiesced registry, so no in-place pruning in v1).
 */
export function projectRegistryStorageHostPath(projectSlug: string): string {
  return `/var/lib/yaac/registry/${dataDirHash()}/${projectSlug}`
}

/**
 * registries.conf.d drop-in making user-driven `docker push` from a
 * session accept the registry's plain HTTP. Written into the session at
 * setup time (the host is per-project, so it cannot be baked into the
 * shared nestable layer). Scoped to the exact registry host — every
 * other registry keeps full TLS verification.
 */
export function projectRegistryConfDropIn(projectSlug: string): string {
  return [
    '[[registry]]',
    `location = "${projectRegistryHost(projectSlug)}"`,
    'insecure = true',
    '',
  ].join('\n')
}

function registryLabels(projectSlug: string): Record<string, string> {
  return {
    app: REGISTRY_APP_LABEL,
    [LABEL_PROJECT]: projectSlug,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/**
 * kubectl label selector matching every registry object of this project
 * scoped to this install (coexisting installs sharing a namespace never
 * touch each other's registries).
 */
function registrySelector(projectSlug: string): string {
  return [
    `app=${REGISTRY_APP_LABEL}`,
    `${LABEL_PROJECT}=${projectSlug}`,
    `${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`,
  ].join(',')
}

/**
 * Build the registry:2 Deployment. Trusted infra like the proxy, so no
 * runtimeClassName — it runs on runc; the sentry buys no containment for
 * yaac-shipped code and its CPU cost starves the node (see the gvisor.ts
 * module doc). Recreate strategy: two pods would race over the node-local
 * storage hostPath during a rolling overlap.
 */
export function buildProjectRegistryDeploymentManifest(
  projectSlug: string,
  imageRef: string,
): Record<string, unknown> {
  const name = projectRegistryName(projectSlug)
  const selector = { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: registryLabels(projectSlug) },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          containers: [
            {
              name: 'registry',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: PROJECT_REGISTRY_PORT }],
              readinessProbe: {
                httpGet: { path: '/v2/', port: PROJECT_REGISTRY_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [
                { name: 'storage', mountPath: '/var/lib/registry' },
              ],
            },
          ],
          volumes: [
            {
              name: 'storage',
              hostPath: {
                path: projectRegistryStorageHostPath(projectSlug),
                type: 'DirectoryOrCreate',
              },
            },
          ],
        },
      },
    },
  }
}

export function buildProjectRegistryServiceManifest(projectSlug: string): Record<string, unknown> {
  const name = projectRegistryName(projectSlug)
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      type: 'ClusterIP',
      // Allocator-assigned (no longer pinned): sessions resolve the live
      // ClusterIP through the proxy's split-horizon DNS, and the node's
      // hosts.toml is rewritten with the live IP on every ensure.
      selector: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
      // port == targetPort: the network policies list the post-translation
      // port; a remap would diverge.
      ports: [{
        name: 'registry',
        port: PROJECT_REGISTRY_PORT,
        targetPort: PROJECT_REGISTRY_PORT,
      }],
    },
  }
}

/**
 * NetworkPolicy admitting this project's sessions to this project's
 * registry — the SOLE egress hole for session→registry traffic: Cilium
 * unions allow rules across policies, so this punches an exactly-scoped
 * hole through the session-egress CNP's default-deny (which itself has
 * no in-cluster registry allowance — an install-wide rule there could
 * not express "same project only"; see the CNP builder's comment).
 * Per-project rather than shared because registry:2 has no path ACLs: a
 * shared writable registry
 * would let any session overwrite another project's (or the infra) tags.
 * The session-id Exists term keeps the policy off the registry pod
 * itself (it carries the project label too).
 */
export function buildRegistrySessionsNetworkPolicyManifest(
  projectSlug: string,
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(projectSlug)}-sessions`,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      podSelector: {
        matchLabels: { [LABEL_PROJECT]: projectSlug },
        matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{
            podSelector: {
              matchLabels: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
            },
          }],
          ports: [{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }],
        },
      ],
    },
  }
}

/**
 * CiliumNetworkPolicy locking the registry pod's INGRESS to exactly its
 * two legitimate clients: same-project session pods pushing on 5000, and
 * the node (host/remote-node entities — the kubelet readiness probe and
 * containerd pulling pushed refs from the host netns via hosts.toml).
 * The sessions NetworkPolicy above already stops other projects' sessions
 * at their source; this is the receiving-side lock, so no future egress
 * loosening can silently reopen cross-project tag reads/overwrites
 * (registry:2 has no path ACLs). A CNP rather than a k8s NetworkPolicy
 * because the node-side pulls arrive from the host netns, which only
 * Cilium's host/remote-node entities can express.
 */
export function buildRegistryIngressCnpManifest(
  projectSlug: string,
): Record<string, unknown> {
  const registryPort = { port: String(PROJECT_REGISTRY_PORT), protocol: 'TCP' }
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: `${projectRegistryName(projectSlug)}-ingress`,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      endpointSelector: {
        matchLabels: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
      },
      ingress: [
        {
          fromEndpoints: [{
            matchLabels: { [LABEL_PROJECT]: projectSlug },
            matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
          }],
          toPorts: [{ ports: [registryPort] }],
        },
        {
          fromEntities: ['host', 'remote-node'],
          toPorts: [{ ports: [registryPort] }],
        },
      ],
    },
  }
}

/**
 * Deny-all egress on the registry pod: it only ever serves pushes and
 * pulls — there is nothing for it to fetch (no pull-through, no proxy
 * pseudo-session). Ingress is locked separately by
 * buildRegistryIngressCnpManifest.
 */
export function buildRegistryEgressNetworkPolicyManifest(
  projectSlug: string,
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(projectSlug)}-egress`,
      namespace: k8sNamespace(),
      labels: registryLabels(projectSlug),
    },
    spec: {
      podSelector: {
        matchLabels: { app: REGISTRY_APP_LABEL, [LABEL_PROJECT]: projectSlug },
      },
      policyTypes: ['Egress'],
      egress: [],
    },
  }
}

/**
 * Scaffolding shared by the one-shot node-write pods that replaced the
 * old `podman exec <node>` writes: node files are written by a pod that
 * hostPath-mounts the target directory, so the server never assumes the
 * node is a container on its own podman engine. Pinned by `nodeName`
 * (bypasses the scheduler, so taints cannot strand it), plain root like
 * the registry itself, `restartPolicy: Never` — the caller polls it to a
 * terminal phase and deletes it. Names carry a per-run random suffix so
 * two runs can never fight over one pod name (delete each other's pod
 * mid-poll); strays from crashed runs are reaped by label — the
 * `LABEL_NODE_WRITE` sweep before each hosts write, and
 * `removeProjectRegistry`'s by-selector delete. It reuses the registry:2
 * mirror image (already in the local registry, and on the node once the
 * registry Deployment has rolled out), and its registry labels both put
 * it under the deny-all egress NetworkPolicy (it needs no network) and
 * inside the removal selector's scope.
 */
function buildNodeWritePodManifest(
  projectSlug: string,
  kind: 'hosts' | 'cleanup',
  name: string,
  nodeName: string,
  imageRef: string,
  script: string,
  volumes: Array<{ name: string; hostPath: { path: string; type: string } }>,
  volumeMounts: Array<{ name: string; mountPath: string }>,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...registryLabels(projectSlug), [LABEL_NODE_WRITE]: kind },
    },
    spec: {
      nodeName,
      // Trusted infra (runs a fixed yaac-authored script) — no
      // runtimeClassName, so it runs on runc like the proxy and registry.
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [{
        name: 'write',
        image: imageRef,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', script],
        volumeMounts,
      }],
      volumes,
    },
  }
}

/**
 * One-shot pod writing the node containerd hosts.toml for this project's
 * registry. The hostPath is scoped to exactly the one
 * `certs.d/<registry-host>` directory (`DirectoryOrCreate` replaces the
 * old `mkdir -p`), so the pod can affect no other registry's mapping.
 */
export function buildRegistryHostsWriterPodManifest(
  projectSlug: string,
  imageRef: string,
  nodeName: string,
  vip: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  const content = `[host."http://${vip}:${PROJECT_REGISTRY_PORT}"]`
  return buildNodeWritePodManifest(
    projectSlug,
    'hosts',
    `${projectRegistryName(projectSlug)}-hosts-${nodeIndex}-${runId}`,
    nodeName,
    imageRef,
    `printf '%s\\n' '${content}' > /host-certs/hosts.toml`,
    [{
      name: 'certs',
      hostPath: {
        path: `/etc/containerd/certs.d/${projectRegistryHost(projectSlug)}`,
        type: 'DirectoryOrCreate',
      },
    }],
    [{ name: 'certs', mountPath: '/host-certs' }],
  )
}

/**
 * One-shot pod removing this project's node-side residue: the certs.d
 * directory and the registry storage. Unlike the writer it mounts the
 * PARENT directories — removing the child dirs themselves (not just
 * their contents) requires it, matching what `podman exec rm -rf` did.
 * Wider mounts than the writer's, but the pod lives for seconds and runs
 * only at project removal.
 */
export function buildRegistryCleanupPodManifest(
  projectSlug: string,
  imageRef: string,
  nodeName: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  return buildNodeWritePodManifest(
    projectSlug,
    'cleanup',
    `${projectRegistryName(projectSlug)}-cleanup-${nodeIndex}-${runId}`,
    nodeName,
    imageRef,
    `rm -rf '/host-certs/${projectRegistryHost(projectSlug)}' '/host-storage/${projectSlug}'`,
    [
      {
        name: 'certs',
        hostPath: { path: '/etc/containerd/certs.d', type: 'DirectoryOrCreate' },
      },
      {
        name: 'storage',
        hostPath: { path: `/var/lib/yaac/registry/${dataDirHash()}`, type: 'DirectoryOrCreate' },
      },
    ],
    [
      { name: 'certs', mountPath: '/host-certs' },
      { name: 'storage', mountPath: '/host-storage' },
    ],
  )
}

/**
 * Ensure the registry:2 mirror (digest-pinned) exists in the local
 * registry and return its in-cluster ref — same build-or-skip shape as
 * `ensureRedirectInitImage`. The mirror is what lets the node pull the
 * image with zero upstream egress at pod-create time.
 */
export async function ensureRegistryImage(
  requirePrebuilt = testEnv.requirePrebuiltImages,
): Promise<string> {
  if (await registryHasTag(REGISTRY_MIRROR_TAG)) return registryRef(REGISTRY_MIRROR_TAG)

  if (!await imageExists(REGISTRY_MIRROR_TAG)) {
    if (requirePrebuilt) {
      throw new Error(
        `Registry image ${REGISTRY_MIRROR_TAG} is missing. ` +
        'Restart the test run so the global setup can mirror it.',
      )
    }
    await execFileAsync('podman', ['pull', REGISTRY_UPSTREAM_IMAGE], { timeout: 300_000 })
    await execFileAsync('podman', ['tag', REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG])
  }
  return pushImageToRegistry(REGISTRY_MIRROR_TAG)
}

interface RawNodeList {
  items: Array<{ metadata: { name: string } }>
}

/** Node names, for pinning the one-shot node-write pods via `nodeName`. */
async function listNodeNames(): Promise<string[]> {
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  return (list?.items ?? []).map((n) => n.metadata.name)
}

/**
 * Run a node-write pod to a terminal phase (`runPodToCompletion` owns the
 * delete-stray/apply/poll/cleanup shape) and require Succeeded; failures
 * carry the pod logs.
 */
async function runNodeWritePod(manifest: Record<string, unknown>): Promise<void> {
  const name = (manifest as { metadata: { name: string } }).metadata.name
  const { phase, logs } = await runPodToCompletion(manifest, { timeoutMs: 60_000, pollMs: 500 })
  if (phase !== 'Succeeded') {
    throw new Error(
      `node-write pod ${name} did not complete (phase ${phase})`
      + (logs.trim() ? `; logs: ${logs.trim()}` : ''),
    )
  }
}

/**
 * Write the node containerd hosts.toml mapping the registry's svc-DNS host to
 * its live ClusterIP URL, so `kubectl run` of a pushed ref pulls straight from
 * the in-cluster registry. Written by a one-shot in-cluster pod, NOT
 * `podman exec <node>`: the server host's engine need not be the one hosting
 * the node, and node names need not be container names. The node is not a
 * cluster-DNS client, so it needs the IP here; hosts.toml is read per-pull
 * (no containerd restart) and is rewritten on every ensure, so the
 * allocator-assigned IP is always current. Must run after the Service is
 * applied and the Deployment rolled out (the rollout also guarantees the
 * writer pod's own image is already on the node).
 */
export async function writeNodeRegistryHostsToml(projectSlug: string): Promise<void> {
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', projectRegistryName(projectSlug), '-n', k8sNamespace(),
  ])
  const vip = svc?.spec?.clusterIP
  if (!vip) throw new Error(`project registry Service ${projectRegistryName(projectSlug)} has no ClusterIP yet`)
  // Reap stray writer/cleanup pods left by crashed runs (a daemon killed
  // mid-poll never reaches runPodToCompletion's cleanup delete, and the
  // per-run name suffix means no later namesake delete collects them).
  // The node-write marker keeps the registry Deployment's pod out of the
  // selector's reach.
  await kubectlWithRetry([
    'delete', 'pod', '-l', `${registrySelector(projectSlug)},${LABEL_NODE_WRITE}`,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    await runNodeWritePod(buildRegistryHostsWriterPodManifest(projectSlug, imageRef, node, vip, i, runId))
  }
}

/** Per-project queue behind `ensureProjectRegistry` (see its doc). */
const registryEnsureMutex = createKeyedMutex()

/**
 * Idempotently stand up the project's registry (Deployment + Service + the
 * network policies + node hosts.toml) and wait for it to serve. Called from
 * session-create only for `virtualCluster` sessions — nested-only sessions
 * need no registry. The Service's ClusterIP is allocator-assigned and never
 * deleted, so `apply` is a no-op on it after first creation (the pin and its
 * immutable-field migration are gone).
 *
 * Serialized per project: concurrent creates on one project are routine
 * (a user create racing a prewarm spare spawn, cron fires, and queued
 * yaac-spawn requests — all bursting on the first background tick after a
 * daemon start), and unserialized ensures would interleave the applies,
 * rollout waits, and node-write pod runs. The ensure is idempotent, so
 * the queued caller's turn is quick; different projects still ensure in
 * parallel.
 */
export async function ensureProjectRegistry(projectSlug: string): Promise<void> {
  await registryEnsureMutex(projectSlug, async () => {
    const name = projectRegistryName(projectSlug)
    const ns = k8sNamespace()
    const imageRef = await ensureRegistryImage()

    await kubectlApply(buildProjectRegistryDeploymentManifest(projectSlug, imageRef))
    await kubectlApply(buildProjectRegistryServiceManifest(projectSlug))
    await kubectlApply(buildRegistrySessionsNetworkPolicyManifest(projectSlug))
    await kubectlApply(buildRegistryIngressCnpManifest(projectSlug))
    await kubectlApply(buildRegistryEgressNetworkPolicyManifest(projectSlug))
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
    ], { timeout: 130_000, maxAttempts: 2 })
    await writeNodeRegistryHostsToml(projectSlug)
  })
}

/**
 * Tear down a project's registry objects plus its node-side residue
 * (hosts.toml dir, storage), the latter via one-shot cleanup pods. The
 * delete selector includes the install scope label so coexisting installs
 * sharing a namespace never delete each other's registries; `pod` is in
 * the kinds so stray writer/cleanup pods from crashed runs are reaped.
 */
export async function removeProjectRegistry(projectSlug: string): Promise<void> {
  const selector = registrySelector(projectSlug)

  // Node-side residue exists only if the registry itself ever did (both
  // dirs are written by the Deployment's pod and the hosts writer). Probe
  // before deleting and skip the cleanup pods for registry-less projects:
  // their cleanup pod can't even start — the mirror image was never pushed,
  // and a nested session's vcluster pod guard denies the node hostPath
  // mounts — so each one would sit Pending for runNodeWritePod's full 60s
  // deadline, stalling every project remove.
  const existing = await kubectlGetJson<{ items?: unknown[] }>([
    'get', 'deployment,service', '-l', selector, '-n', k8sNamespace(),
  ])
  const hadRegistry = (existing?.items?.length ?? 0) > 0

  // `ciliumnetworkpolicy` resolves everywhere the server manages a cluster:
  // real installs run Cilium, and a nested yaac installs permissive CNP CRDs
  // into its vcluster at bootstrap (ensureCiliumCrds).
  await kubectlWithRetry([
    'delete', 'deployment,service,networkpolicy,ciliumnetworkpolicy,pod', '-l', selector,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  if (!hadRegistry) return

  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    // Best-effort: the cluster may be recreated or unreachable — and the
    // storage was node-local, so it is already gone with the old node.
    await runNodeWritePod(buildRegistryCleanupPodManifest(projectSlug, imageRef, node, i, runId))
      .catch(() => { /* node-side residue is harmless */ })
  }
}

interface RawServiceList {
  items: Array<{ metadata: { labels?: Record<string, string> } }>
}

/**
 * Server-startup sweep: remove registries whose project no longer exists
 * locally. Catches `yaac project remove` runs that raced a dead cluster,
 * plus hand-deleted project dirs. Scoped to this install via the
 * registry GC label.
 */
export async function gcOrphanProjectRegistries(): Promise<void> {
  let services: RawServiceList | null
  try {
    services = await kubectlGetJson<RawServiceList>([
      'get', 'services', '-n', k8sNamespace(),
      '-l', `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`,
    ])
  } catch (err) {
    console.warn(`Orphan registry GC: failed to list registries: ${(err as Error).message}`)
    return
  }
  for (const item of services?.items ?? []) {
    const slug = item.metadata.labels?.[LABEL_PROJECT]
    if (!slug) continue
    const exists = await fs.access(projectDir(slug)).then(() => true).catch(() => false)
    if (exists) continue
    try {
      await removeProjectRegistry(slug)
      console.log(`Removed orphan project registry for ${slug}`)
    } catch (err) {
      console.warn(`Orphan registry GC: failed to remove ${slug}: ${(err as Error).message}`)
    }
  }
}
