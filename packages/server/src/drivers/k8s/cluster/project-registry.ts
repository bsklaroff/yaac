import crypto from 'node:crypto'
import {
  LABEL_PROJECT,
  LABEL_PROJECT_ID,
  LABEL_WORKSPACE_ID,
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { createKeyedMutex } from '#lib/keyed-mutex'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'
import { registryHasTag, registryRef } from '#drivers/k8s/container'
import { nodeIpBlocks } from './cluster-cidrs'
import { serverLog } from '#log'
import type { ProjectRef } from '#drivers/contract'

/** `app` label value shared by every per-project registry pod. */
export const REGISTRY_APP_LABEL = 'yaac-registry'
/** Ties registry objects to this install without making them visible to
 *  the workspace reaper and listings (which use `yaac.data-dir-hash`). */
export const LABEL_REGISTRY_DATA_DIR_HASH = 'yaac.registry-data-dir-hash'
/** Label on the one-shot node-write pods (value: the pod's kind), so the
 *  stray sweep never selects the registry's own pod. */
export const LABEL_NODE_WRITE = 'yaac.node-write'
/** In-cluster port. Not 443/80, which netd redirects to the proxy. */
export const PROJECT_REGISTRY_PORT = 5000

/** registry:2 pinned by multi-arch index digest, as the main registry
 *  uses. Push-and-serve only; nested pulls go through the proxy. */
export const REGISTRY_IMAGE_DIGEST =
  'sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373'
export const REGISTRY_UPSTREAM_IMAGE = `docker.io/library/registry@${REGISTRY_IMAGE_DIGEST}`
/** Local mirror tag; the digest slice keeps it stable and content-keyed. */
export const REGISTRY_MIRROR_TAG = `yaac-registry2:${REGISTRY_IMAGE_DIGEST.slice(7, 19)}`

/**
 * A project's registry name, `yaac-reg-<id>`. The id is never reused, so a
 * re-added project gets a fresh registry, and no install hash is needed.
 * At 45 chars, derived names fit the 63-char DNS-label limit.
 */
export function projectRegistryName(projectId: string): string {
  return `yaac-reg-${projectId}`
}

/**
 * The registry's full `.svc.cluster.local` name. Workspaces resolve it via
 * the proxy's DNS, which forwards only `.cluster.local` to CoreDNS. Node
 * containerd matches it against the hosts.toml written here.
 */
export function projectRegistryHostname(projectId: string): string {
  return registryHostnameOf(projectRegistryName(projectId))
}

function registryHostnameOf(registryName: string): string {
  return `${registryName}.${k8sNamespace()}.svc.cluster.local`
}

/** `projectRegistryHostname` with the registry port (the image-ref host). */
export function projectRegistryHost(projectId: string): string {
  return `${projectRegistryHostname(projectId)}:${PROJECT_REGISTRY_PORT}`
}

/**
 * The project's registry PVC. reconcileProjectRegistryGc reclaims untagged
 * blobs, but live tags are kept, so a project minting new tags keeps
 * growing until removed.
 */
export function projectRegistryPvcName(projectId: string): string {
  return `${projectRegistryName(projectId)}-storage`
}

/**
 * Requested PVC size per project (ignored by kind's local-path provisioner;
 * a real allocation on cloud providers).
 *
 * Raising it is safe; lowering it is not: the claim is re-applied on every
 * ensure and its size can only grow, so a smaller value fails every ensure
 * on existing installs. Same for MAIN_REGISTRY_STORAGE_SIZE.
 */
export const PROJECT_REGISTRY_STORAGE_SIZE = '50Gi'

/**
 * registries.conf.d drop-in letting a workspace's `docker push` use this
 * registry's plain HTTP. Written at workspace setup (it is per project).
 * Only this host skips TLS verification.
 */
export function projectRegistryConfDropIn(projectId: string): string {
  return [
    '[[registry]]',
    `location = "${projectRegistryHost(projectId)}"`,
    'insecure = true',
    '',
  ].join('\n')
}

/** Labels: the project id (used by selectors, policies and GC) and the
 *  slug (for humans). */
function registryLabels(project: ProjectRef): Record<string, string> {
  return {
    app: REGISTRY_APP_LABEL,
    [LABEL_PROJECT]: project.slug,
    [LABEL_PROJECT_ID]: project.id,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/** What selects one project's registry pod, and nothing else of it. */
function registryPodSelector(projectId: string): Record<string, string> {
  return { app: REGISTRY_APP_LABEL, [LABEL_PROJECT_ID]: projectId }
}

/** kubectl label selector matching every registry object of this install. */
function installRegistrySelector(): string {
  return `app=${REGISTRY_APP_LABEL},${LABEL_REGISTRY_DATA_DIR_HASH}=${dataDirHash()}`
}

/** Selector for this project's registry objects in this install only (the
 *  orphan GC must never see another install's). */
function registrySelector(projectId: string): string {
  return `${installRegistrySelector()},${LABEL_PROJECT_ID}=${projectId}`
}

/**
 * The blob store's claim, using the default storage class. RWO still lets a
 * second pod on the same node mount it, which the collect pod relies on.
 * Losing it loses anything a workspace `docker push`ed here that yaac
 * cannot rebuild.
 */
export function buildProjectRegistryPvcManifest(project: ProjectRef): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: projectRegistryPvcName(project.id),
      namespace: k8sNamespace(),
      labels: registryLabels(project),
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: PROJECT_REGISTRY_STORAGE_SIZE } },
    },
  }
}

/**
 * The registry:2 Deployment. Trusted infra, so runc (see gvisor.ts).
 * `Recreate` avoids two pods on one RWO volume. Not pinned to a node; a
 * bound volume carries its own node affinity.
 *
 * It declares no tolerations on purpose, which keeps it off a tainted
 * workspace pool (that toleration comes from the gVisor RuntimeClass).
 */
export function buildProjectRegistryDeploymentManifest(
  project: ProjectRef,
  imageRef: string,
  opts: { readOnly?: boolean } = {},
): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: projectRegistryName(project.id),
      namespace: k8sNamespace(),
      labels: registryLabels(project),
    },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: registryPodSelector(project.id) },
      template: {
        metadata: { labels: registryLabels(project) },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // The project's workspaces pull their images from here.
          priorityClassName: PRIORITY_CLASS_INFRA,
          containers: [
            {
              name: 'registry',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // Manifest DELETE lets the image cache retire unused chain slots
              // so their blobs can be collected.
              //
              // `readOnly` is the window a blob collect runs in
              // (reconcileProjectRegistryGc): reads work, writes get 405. It must
              // be an inline YAML map; `…_READONLY_ENABLED=true` makes
              // registry 2.8 panic at boot.
              env: [
                { name: 'REGISTRY_STORAGE_DELETE_ENABLED', value: 'true' },
                ...(opts.readOnly
                  ? [{ name: 'REGISTRY_STORAGE_MAINTENANCE_READONLY', value: '{enabled: true}' }]
                  : []),
              ],
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
              persistentVolumeClaim: { claimName: projectRegistryPvcName(project.id) },
            },
          ],
        },
      },
    },
  }
}

export function buildProjectRegistryServiceManifest(project: ProjectRef): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: projectRegistryName(project.id),
      namespace: k8sNamespace(),
      labels: registryLabels(project),
    },
    spec: {
      type: 'ClusterIP',
      // Workspaces resolve the ClusterIP via the proxy's DNS; the node's
      // hosts.toml is rewritten with it on every ensure.
      selector: registryPodSelector(project.id),
      // port == targetPort, since the policies name the pod port.
      ports: [{
        name: 'registry',
        port: PROJECT_REGISTRY_PORT,
        targetPort: PROJECT_REGISTRY_PORT,
      }],
    },
  }
}

/**
 * Egress policy letting this project's workspaces (and only them) reach its
 * registry; the install-wide workspace policy cannot scope by project.
 * Registries are per project because registry:2 has no path ACLs. The
 * workspace-id term keeps the registry pod itself out.
 */
export function buildRegistryWorkspacesNetworkPolicyManifest(
  project: ProjectRef,
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(project.id)}-sessions`,
      namespace: k8sNamespace(),
      labels: registryLabels(project),
    },
    spec: {
      podSelector: {
        matchLabels: { [LABEL_PROJECT_ID]: project.id },
        matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }],
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ podSelector: { matchLabels: registryPodSelector(project.id) } }],
          ports: [{ protocol: 'TCP', port: PROJECT_REGISTRY_PORT }],
        },
      ],
    },
  }
}

/**
 * Registry ingress: same-project workspace pods, and the node (kubelet
 * probe, containerd pulls) by `ipBlock`. A receiving-side check, so a later
 * egress change cannot open cross-project access.
 */
export function buildRegistryIngressNetworkPolicyManifest(
  project: ProjectRef,
  nodeCidrs: string[],
): Record<string, unknown> {
  const registryPort = { protocol: 'TCP', port: PROJECT_REGISTRY_PORT }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(project.id)}-ingress`,
      namespace: k8sNamespace(),
      labels: registryLabels(project),
    },
    spec: {
      podSelector: { matchLabels: registryPodSelector(project.id) },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{
            podSelector: {
              matchLabels: { [LABEL_PROJECT_ID]: project.id },
              matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }],
            },
          }],
          ports: [registryPort],
        },
        {
          from: nodeCidrs.map((cidr) => ({ ipBlock: { cidr } })),
          ports: [registryPort],
        },
      ],
    },
  }
}

/** Deny-all egress for the registry pod, which only serves. */
export function buildRegistryEgressNetworkPolicyManifest(
  project: ProjectRef,
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${projectRegistryName(project.id)}-egress`,
      namespace: k8sNamespace(),
      labels: registryLabels(project),
    },
    spec: {
      podSelector: { matchLabels: registryPodSelector(project.id) },
      policyTypes: ['Egress'],
      egress: [],
    },
  }
}

/**
 * Shared shape of the one-shot pods that write node files (via a hostPath
 * mount) or collect the registry. Run to completion, then deleted by the
 * caller. Names have a per-run suffix so runs never collide; strays are
 * removed by label. Uses the registry:2 image already on the node, and the
 * registry labels put it under the deny-all egress policy.
 *
 * Node-file pods are pinned with `nodeName` and tolerate every taint (a
 * `NoExecute` taint would otherwise evict them). The collect pod is
 * scheduled with `affinity` instead (see `buildRegistryGcPodManifest`); the
 * toleration is harmless there, since it must land beside the registry.
 */
function buildNodeWritePodManifest(
  labels: Record<string, string>,
  kind: 'hosts' | 'cleanup' | 'gc',
  name: string,
  nodeName: string | null,
  imageRef: string,
  script: string,
  volumes: Array<Record<string, unknown>>,
  volumeMounts: Array<{ name: string; mountPath: string }>,
  affinity?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: k8sNamespace(),
      labels: { ...labels, [LABEL_NODE_WRITE]: kind },
    },
    spec: {
      ...(nodeName ? { nodeName } : {}),
      ...(affinity ? { affinity } : {}),
      // Trusted infra: runc.
      restartPolicy: 'Never',
      // See above: a NoExecute taint would otherwise evict it.
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
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

/** One-shot pod writing a node's containerd hosts.toml for this registry.
 *  Its hostPath is only this registry's `certs.d` dir. */
export function buildRegistryHostsWriterPodManifest(
  project: ProjectRef,
  imageRef: string,
  nodeName: string,
  vip: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  const content = `[host."http://${vip}:${PROJECT_REGISTRY_PORT}"]`
  return buildNodeWritePodManifest(
    registryLabels(project),
    'hosts',
    `${projectRegistryName(project.id)}-hosts-${nodeIndex}-${runId}`,
    nodeName,
    imageRef,
    `printf '%s\\n' '${content}' > /host-certs/hosts.toml`,
    [{
      name: 'certs',
      hostPath: {
        path: `/etc/containerd/certs.d/${projectRegistryHost(project.id)}`,
        type: 'DirectoryOrCreate',
      },
    }],
    [{ name: 'certs', mountPath: '/host-certs' }],
  )
}

/**
 * One-shot pod removing the registry's `certs.d` dir from a node, the only
 * thing it writes outside the API server (the PVC goes with the other
 * objects). Mounts the parent dir so it can remove the child.
 *
 * Takes a name and labels rather than a project, because the orphan GC also
 * removes registries named before project ids
 * (docs/legacy-compat-shims.md, "Registries named before project ids").
 */
export function buildRegistryCleanupPodManifest(
  registryName: string,
  labels: Record<string, string>,
  imageRef: string,
  nodeName: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  return buildNodeWritePodManifest(
    labels,
    'cleanup',
    `${registryName}-cleanup-${nodeIndex}-${runId}`,
    nodeName,
    imageRef,
    `rm -rf '/host-certs/${registryHostnameOf(registryName)}:${PROJECT_REGISTRY_PORT}'`,
    [{
      name: 'certs',
      hostPath: { path: '/etc/containerd/certs.d', type: 'DirectoryOrCreate' },
    }],
    [{ name: 'certs', mountPath: '/host-certs' }],
  )
}

/** Storage mount in the GC pod: the stock config's `rootdirectory`. */
const GC_STORAGE_PATH = '/var/lib/registry'
/** The stock config the mirrored image ships, which the GC run re-reads. */
const GC_CONFIG_PATH = '/etc/docker/registry/config.yml'
/** v2 layout root holding one directory per repository. */
const GC_REPOS_PATH = `${GC_STORAGE_PATH}/docker/registry/v2/repositories`

/**
 * Content-hash generations kept per yaac-built repo. Higher than the host's
 * HOST_GENERATIONS_KEPT because workspaces on different branches each use
 * their own hash at once.
 */
export const REGISTRY_GENERATIONS_KEPT = 8

/**
 * Shell script that untags all but the newest `keep` content-hash
 * generations of each yaac-built repo, so `--delete-untagged` can reclaim
 * them (each source change otherwise adds a tag that lives forever). Same
 * policy as the host's image-gc.ts.
 *
 * Only repos named `yaac-*` and tags that are 16 hex chars are touched, so
 * user repos, `latest` and `yaac-cache-…` slots never are. It edits the
 * storage layout directly, since it runs in the read-only window where
 * DELETE is refused.
 *
 * The main registry reuses it (`#drivers/k8s/images` main-registry-gc.ts)
 * with a smaller `keep`, `protect` (`repo:tag` refs never retired but still
 * counted) and `skip` (shell `case` patterns). Prints `RETIRED <repo>:<tag>`
 * per tag, then the count.
 */
export function buildRegistryRetentionScript(opts: {
  keep?: number
  protect?: string[]
  skip?: string[]
} = {}): string {
  const keep = opts.keep ?? REGISTRY_GENERATIONS_KEPT
  const skip = opts.skip ?? []
  return [
    `[ -d ${GC_REPOS_PATH} ] || exit 0`,
    // Image-name charset only, so single quotes are safe.
    `PROTECT='${(opts.protect ?? []).join('\n')}'`,
    'retired=0',
    `for tagdir in $(find ${GC_REPOS_PATH} -type d -path '*/_manifests/tags' 2>/dev/null); do`,
    `  repo=\${tagdir#${GC_REPOS_PATH}/}; repo=\${repo%/_manifests/tags}`,
    '  case "$repo" in',
    ...(skip.length > 0 ? [`    ${skip.join('|')}) continue;;`] : []),
    '    yaac-*) ;;',
    '    *) continue;;',
    '  esac',
    // Newest first by tag-dir mtime, i.e. creation time (a re-push does not
    // change it). Fine for write-once content-hash tags, not mutable ones.
    `  for stale in $(ls -1t "$tagdir" 2>/dev/null | grep -Ex '[0-9a-f]{16}' | tail -n +${keep + 1}); do`,
    '    printf \'%s\\n\' "$PROTECT" | grep -qxF "$repo:$stale" && continue',
    '    rm -rf "$tagdir/$stale" && retired=$((retired+1)) && echo "RETIRED $repo:$stale"',
    '  done',
    'done',
    'echo "retired-generations $retired"',
  ].join('\n')
}

/**
 * One-shot pod reclaiming a project's registry blobs: the retention script,
 * then `registry garbage-collect --delete-untagged` on the registry's PVC.
 * Rebuilds re-point reused tags, leaving old manifests untagged; this
 * deletes them and their blobs.
 *
 * It mounts the same RWO claim as the serving registry, which works only on
 * the same node. A required podAffinity to the registry pod enforces that;
 * the scheduler does not for CSI volumes (it would fail at attach with
 * Multi-Attach), and `nodeName` would skip the scheduler entirely.
 */
export function buildRegistryGcPodManifest(
  project: ProjectRef,
  imageRef: string,
  runId: string,
): Record<string, unknown> {
  return buildNodeWritePodManifest(
    registryLabels(project),
    'gc',
    `${projectRegistryName(project.id)}-gc-${runId}`,
    null,
    imageRef,
    // Retention first: it untags the generations the collect then reclaims.
    `${buildRegistryRetentionScript()}\n`
    + `/bin/registry garbage-collect --delete-untagged=true ${GC_CONFIG_PATH}`,
    [{
      name: 'storage',
      persistentVolumeClaim: { claimName: projectRegistryPvcName(project.id) },
    }],
    [{ name: 'storage', mountPath: GC_STORAGE_PATH }],
    {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [{
          // The registry pod: same labels, minus other one-shot pods.
          labelSelector: {
            matchLabels: registryLabels(project),
            matchExpressions: [{ key: LABEL_NODE_WRITE, operator: 'DoesNotExist' }],
          },
          topologyKey: 'kubernetes.io/hostname',
        }],
      },
    },
  )
}

/** The registry:2 mirror's in-cluster ref. Lookup-only; `yaac cluster
 *  install` mirrors it. */
export async function ensureRegistryImage(): Promise<string> {
  if (await registryHasTag(REGISTRY_MIRROR_TAG)) return registryRef(REGISTRY_MIRROR_TAG)
  throw missingPrebuiltImage('Registry', REGISTRY_MIRROR_TAG)
}

interface RawNodeList {
  items: Array<{ metadata: { name: string } }>
}

/** Node names, for pinning the one-shot node-write pods via `nodeName`. */
async function listNodeNames(): Promise<string[]> {
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  return (list?.items ?? []).map((n) => n.metadata.name)
}

/** Run a node-write pod to completion; throws with its logs unless it
 *  Succeeded. */
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
 * The registry Service's ClusterIP, or null if none yet (or unreachable).
 * Consumers without cluster DNS (node hosts.toml, the hostNetwork image-store
 * builder) must read it fresh.
 */
export async function projectRegistryClusterIp(projectId: string): Promise<string | null> {
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', projectRegistryName(projectId), '-n', k8sNamespace(),
  ]).catch(() => null)
  return svc?.spec?.clusterIP ?? null
}

/**
 * Write every node's containerd hosts.toml mapping the registry's DNS name
 * to its ClusterIP (nodes do not use cluster DNS). Read per pull, and
 * rewritten on every ensure. Must run after the Deployment rolls out, which
 * also puts the writer pod's image on the node.
 */
export async function writeNodeRegistryHostsToml(project: ProjectRef): Promise<void> {
  const vip = await projectRegistryClusterIp(project.id)
  if (!vip) throw new Error(`project registry Service ${projectRegistryName(project.id)} has no ClusterIP yet`)
  // Remove one-shot pods left by crashed runs.
  await kubectlWithRetry([
    'delete', 'pod', '-l', `${registrySelector(project.id)},${LABEL_NODE_WRITE}`,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    await runNodeWritePod(buildRegistryHostsWriterPodManifest(project, imageRef, node, vip, i, runId))
  }
}

/** Per-project queue behind `ensureProjectRegistry` (see its doc). */
const registryEnsureMutex = createKeyedMutex()

/**
 * Create or update the project's registry (PVC, Deployment, Service,
 * policies, node hosts.toml) and wait for it to serve. Called for every
 * `nestedContainers` workspace; the cross-workspace image cache uses it.
 * Serialized per project, since concurrent creates on one project are
 * common.
 */
export async function ensureProjectRegistry(project: ProjectRef): Promise<void> {
  await registryEnsureMutex(project.id, async () => {
    const name = projectRegistryName(project.id)
    const ns = k8sNamespace()
    const imageRef = await ensureRegistryImage()

    // The claim before the Deployment that mounts it.
    await kubectlApply(buildProjectRegistryPvcManifest(project))
    await kubectlApply(buildProjectRegistryDeploymentManifest(project, imageRef))
    await kubectlApply(buildProjectRegistryServiceManifest(project))
    await kubectlApply(buildRegistryWorkspacesNetworkPolicyManifest(project))
    await kubectlApply(buildRegistryIngressNetworkPolicyManifest(project, await nodeIpBlocks()))
    await kubectlApply(buildRegistryEgressNetworkPolicyManifest(project))
    try {
      await kubectlWithRetry([
        'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
      ], { timeout: 130_000, maxAttempts: 2 })
    } catch (err) {
      // kubectl only reports a timeout; point at the likely storage cause.
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n`
        + `Inspect with \`kubectl -n ${ns} get pods,pvc -l ${registrySelector(project.id)}\` — `
        + 'a Pending PVC means the cluster has no default StorageClass to bind '
        + 'it, or the provisioner refused the request.',
      )
    }
    await writeNodeRegistryHostsToml(project)
  })
}

/** Delete a project's registry objects (PVC included) and each node's
 *  hosts.toml dir. Scoped to this install. */
export async function removeProjectRegistry(projectId: string): Promise<void> {
  const selector = registrySelector(projectId)
  // Skip the node cleanup if no registry ever existed; its pod could not
  // start (no mirror image) and would stall the remove for 60s per node.
  const existing = await kubectlGetJson<{ items?: unknown[] }>([
    'get', 'deployment,service', '-l', selector, '-n', k8sNamespace(),
  ])
  const hadRegistry = (existing?.items?.length ?? 0) > 0
  await removeRegistry(
    selector,
    hadRegistry ? projectRegistryName(projectId) : null,
    registryIdLabels(projectId),
  )
}

/** The labels an id's registry objects are selected by (`registrySelector`). */
function registryIdLabels(projectId: string): Record<string, string> {
  return {
    app: REGISTRY_APP_LABEL,
    [LABEL_PROJECT_ID]: projectId,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/** Delete the registry objects `selector` matches, then, if `name` is
 *  set, its hosts.toml dir on each node. */
async function removeRegistry(
  selector: string,
  name: string | null,
  cleanupLabels: Record<string, string>,
): Promise<void> {
  // Deleting the PVC while mounted is fine; it waits for the pod to go.
  await kubectlWithRetry([
    'delete', 'deployment,service,networkpolicy,persistentvolumeclaim,pod', '-l', selector,
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  if (!name) return

  const imageRef = registryRef(REGISTRY_MIRROR_TAG)
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    // Best-effort.
    await runNodeWritePod(buildRegistryCleanupPodManifest(name, cleanupLabels, imageRef, node, i, runId))
      .catch(() => { /* node-side residue is harmless */ })
  }
}

interface RawServiceList {
  items: Array<{ metadata: { labels?: Record<string, string>; creationTimestamp?: string } }>
}

/** How often a project's registry is collected. Each pass restarts the
 *  registry, and garbage accrues slowly. */
export const REGISTRY_GC_INTERVAL_MS = 6 * 60 * 60_000

/** Deadline for the collect run itself — it walks every blob in the store. */
export const REGISTRY_GC_TIMEOUT_MS = 10 * 60_000

/** Last collect per project id (in memory). */
const lastRegistryGcMs = new Map<string, number>()

/**
 * When the registry last had nothing to collect: its last collect, else the
 * Service's creation time. Using creation time keeps a brand-new registry
 * (busy with its first workspace) from getting a maintenance window right
 * away, and survives server restarts. An unparseable timestamp counts as
 * eligible.
 */
function gcBaselineMs(projectId: string, creationTimestamp?: string): number {
  const collected = lastRegistryGcMs.get(projectId)
  if (collected !== undefined) return collected
  const created = Date.parse(creationTimestamp ?? '')
  return Number.isNaN(created) ? 0 : created
}

/** Test hook: forget the per-project throttle and any in-flight collect. */
export function _resetRegistryGcForTests(): void {
  lastRegistryGcMs.clear()
  inFlightCollect = null
}

/** The running collect, if any; one at a time per install. */
let inFlightCollect: Promise<void> | null = null

/** Test hook: await the detached collect this pass started. */
export function _registryGcSettledForTests(): Promise<void> {
  return inFlightCollect ?? Promise.resolve()
}

/**
 * Start a blob collect in one due project registry, detached (it takes
 * minutes and would stall the reconcile loop).
 *
 * Garbage collection is unsafe during a push (uploaded blobs without a
 * manifest look like garbage), and active registries are never idle. So the
 * registry is rolled into read-only mode: pulls keep working, and pushes or
 * deletes get 405 and are retried next cycle. It costs two `Recreate`
 * rollouts, a few seconds of downtime each.
 *
 * Only live projects are collected; the orphan sweep removes dead ones, and
 * a collect's `finally` would otherwise recreate a removed Deployment.
 */
export async function reconcileProjectRegistryGc(
  liveProjectIds: ReadonlySet<string>,
  now = Date.now(),
): Promise<void> {
  if (inFlightCollect) return
  let services: RawServiceList | null
  try {
    services = await kubectlGetJson<RawServiceList>([
      'get', 'services', '-n', k8sNamespace(), '-l', installRegistrySelector(),
    ])
  } catch (err) {
    console.warn(`Registry GC: failed to list registries: ${(err as Error).message}`)
    return
  }
  for (const item of services?.items ?? []) {
    const labels = item.metadata.labels ?? {}
    const id = labels[LABEL_PROJECT_ID]
    if (!id || !liveProjectIds.has(id)) continue
    if (now - gcBaselineMs(id, item.metadata.creationTimestamp)
      < REGISTRY_GC_INTERVAL_MS) continue
    lastRegistryGcMs.set(id, now)
    const project = { slug: labels[LABEL_PROJECT] ?? id, id }
    inFlightCollect = collectProjectRegistry(project)
      .catch((err: unknown) => {
        console.warn(`Registry GC for ${project.slug} failed: ${String(err)}`)
      })
      .finally(() => { inFlightCollect = null })
    return
  }
}

/** The collect, under the project's ensure mutex, so a workspace create
 *  waits for it (at worst two rollouts plus REGISTRY_GC_TIMEOUT_MS). */
async function collectProjectRegistry(project: ProjectRef): Promise<void> {
  await registryEnsureMutex(project.id, async () => {
    const name = projectRegistryName(project.id)
    const ns = k8sNamespace()
    const imageRef = registryRef(REGISTRY_MIRROR_TAG)
    const roll = async (readOnly: boolean): Promise<void> => {
      await kubectlApply(
        buildProjectRegistryDeploymentManifest(project, imageRef, { readOnly }))
      await kubectlWithRetry([
        'rollout', 'status', `deployment/${name}`, '-n', ns, '--timeout=120s',
      ], { timeout: 130_000, maxAttempts: 2 })
    }

    await roll(true)
    try {
      // Scheduled beside the registry pod by its podAffinity.
      const runId = crypto.randomBytes(4).toString('hex')
      const { phase, logs } = await runPodToCompletion(
        buildRegistryGcPodManifest(project, imageRef, runId),
        { timeoutMs: REGISTRY_GC_TIMEOUT_MS, pollMs: 1000 },
      )
      if (phase !== 'Succeeded') {
        throw new Error(`collect pod did not complete (phase ${phase})`
          + (logs.trim() ? `; logs: ${logs.trim()}` : ''))
      }
      serverLog(`[server] registry gc: project=${project.slug} ${logs.trim().split('\n').pop() ?? ''}`)
    } finally {
      // Always restore, so a failed collect never leaves it read-only.
      await roll(false).catch((err: unknown) => {
        console.warn(`Registry GC: failed to restore ${project.slug} to serving: ${String(err)}`)
      })
    }
  })
}

/** Minimum age before the orphan sweep removes a registry object, so a
 *  project added after the pass read its live set is not mistaken for an
 *  orphan. */
export const ORPHAN_REGISTRY_MIN_AGE_MS = 10 * 60_000

/** How often the orphan sweep runs per server life. */
export const ORPHAN_REGISTRY_GC_INTERVAL_MS = 60 * 60_000

let lastOrphanGcMs: number | undefined

/** Test hook: forget the orphan sweep's throttle. */
export function _resetOrphanRegistryGcForTests(): void {
  lastOrphanGcMs = undefined
}

interface RawRegistryObjectList {
  items: Array<{
    kind: string
    metadata: { name: string; labels?: Record<string, string>; creationTimestamp?: string }
  }>
}

/**
 * Remove this install's registries belonging to no live project: an id not
 * in `liveProjectIds`, or no id at all (legacy slug-named registries). Keyed
 * on ids, so it also catches failed removals. Lists every object kind, so a
 * partially created registry still goes. Id-less objects are grouped by
 * slug, excluding id-labelled ones.
 */
export async function gcOrphanProjectRegistries(
  liveProjectIds: ReadonlySet<string>,
  now = Date.now(),
): Promise<void> {
  if (lastOrphanGcMs !== undefined && now - lastOrphanGcMs < ORPHAN_REGISTRY_GC_INTERVAL_MS) return
  lastOrphanGcMs = now
  let list: RawRegistryObjectList | null
  try {
    list = await kubectlGetJson<RawRegistryObjectList>([
      'get', 'deployment,service,persistentvolumeclaim', '-n', k8sNamespace(),
      '-l', installRegistrySelector(),
    ])
  } catch (err) {
    console.warn(`Orphan registry GC: failed to list registries: ${(err as Error).message}`)
    return
  }
  // selector → Deployment/Service name (for the hosts.toml cleanup) and
  // the cleanup pods' labels.
  const orphans = new Map<string, { name: string | null; labels: Record<string, string> }>()
  for (const { kind, metadata } of list?.items ?? []) {
    const labels = metadata.labels ?? {}
    const id = labels[LABEL_PROJECT_ID]
    if (id !== undefined && liveProjectIds.has(id)) continue
    // An unreadable age is never old enough.
    const created = Date.parse(metadata.creationTimestamp ?? '')
    if (Number.isNaN(created) || now - created < ORPHAN_REGISTRY_MIN_AGE_MS) continue
    const slug = labels[LABEL_PROJECT]
    const target = id !== undefined
      ? { selector: registrySelector(id), labels: registryIdLabels(id) }
      // A registry named before project ids: legacy-compat
      // (docs/legacy-compat-shims.md, "Registries named before project ids").
      : slug !== undefined
        ? {
          selector: `${installRegistrySelector()},${LABEL_PROJECT}=${slug},!${LABEL_PROJECT_ID}`,
          labels: { app: REGISTRY_APP_LABEL, [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash() },
        }
        : null
    if (!target) continue
    const name = kind === 'PersistentVolumeClaim' ? null : metadata.name
    orphans.set(target.selector, {
      name: orphans.get(target.selector)?.name ?? name,
      labels: target.labels,
    })
  }
  for (const [selector, { name, labels }] of orphans) {
    try {
      await removeRegistry(selector, name, labels)
      console.log(`Removed orphan project registry (${selector})`)
    } catch (err) {
      console.warn(`Orphan registry GC: failed to remove ${selector}: ${(err as Error).message}`)
    }
  }
}
