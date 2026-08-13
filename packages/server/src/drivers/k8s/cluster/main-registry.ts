/**
 * The install's main OCI registry, as an in-cluster workload.
 *
 * This is the one image bus (docs/trust-split-builds.md): host-side
 * `podman build` pushes trusted layers into it, sandboxed builder pods pull
 * their parents from it and push their products back, node containerd pulls
 * every worktree image from it, and the vcluster chart's images are named
 * through it. It is deliberately the SAME topology as the per-project
 * registries (project-registry.ts) rather than a second pattern:
 * digest-pinned `registry:2`, a Recreate Deployment, a selector-backed
 * ClusterIP Service, an RWO PVC for the blobs, and a per-node containerd
 * `hosts.toml` written by one-shot pods that hostPath-mount the node's
 * `certs.d` directory.
 *
 * Three things differ from a project registry, all for the same reason —
 * this one is install-wide infrastructure, not a per-project store:
 *
 *  - It lives in the DEFAULT namespace (`REGISTRY_NAMESPACE`), not
 *    `k8sNamespace()`, so per-run e2e namespaces keep sharing one image
 *    store.
 *  - Its image is the UPSTREAM digest ref, not the local mirror tag: the
 *    registry cannot be the source of its own image, and the same goes for
 *    the node-write pods that wire it up.
 *  - Its ingress lock admits a different caller set: node CIDRs (containerd
 *    pulls and the kubelet probe, plus the server's port-forward, which
 *    arrives from the node) and builder pods in ANY namespace, rather than
 *    one project's worktrees. Worktree pods are not on that list and cannot
 *    reach it anyway — their own default-deny egress
 *    (`buildWorktreeEgressNpManifest`) admits nothing but the node's netd
 *    listener range. Note the world-deny policy is NOT what stops them: it
 *    explicitly excludes worktree-labeled pods.
 *
 * On the lock's limits, so the rationale is not read as more than it is:
 * builder pods are the UNTRUSTED principal of the trust split — an
 * attacker-authored `RUN` step runs inside one — and they must be able to
 * push, so no network policy can stop a builder-origin write to an
 * arbitrary repo:tag in an unauthenticated registry:2. What the lock buys
 * is the same thing the project registries' does: it pins the caller set so
 * a future egress loosening cannot silently widen it. Closing the
 * builder-origin write surface needs auth or path scoping; the open risk is
 * written up in docs/trust-split-builds.md.
 *
 * The server reaches it through a `kubectl port-forward`, not by any host
 * networking assumption — see `#drivers/k8s/container`'s registry module for
 * the cluster-ref vs process-endpoint split.
 *
 * Storage is an RWO PVC, exactly as the per-project registries store
 * theirs. The store therefore belongs to the CLAIM rather than to whatever
 * node the pod last landed on, which is what makes an unpinned Deployment
 * safe: a reschedule takes the volume with it, so nothing is stranded and
 * nothing silently swaps underneath a running collect. A `nodeSelector`
 * would close the same two holes and is the wrong trade — it turns a
 * self-healing degradation into a single point of failure, on exactly the
 * store a node replacement destroys.
 *
 * RWO is enough because `replicas: 1` + `Recreate` means one mounter at a
 * time by construction, and it is the access mode every backend has (RWX
 * needs a file storage class that most do not ship). Two consumers on the
 * SAME node are still fine under RWO — which is what lets the build-cache
 * collect's sibling in project-registry.ts mount the volume beside a
 * serving registry.
 *
 * A claim that never binds — a cluster with NO default StorageClass — leaves
 * the registry down rather than degraded, since `Recreate` takes the serving
 * pod away first. `cluster setup` reports that precisely; the boot ensure
 * only logs it. Losing the volume itself costs nothing permanent:
 * `registryHasTag` misses and the pushers refill, the same self-healing the
 * store relies on for a cluster recreate.
 */
import crypto from 'node:crypto'
import {
  dataDirHash,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  LABEL_ROLE,
  PRIORITY_CLASS_INFRA,
  PRIVILEGED_PSS_LABELS,
  ROLE_BUILDER,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { nodeIpBlocks } from './cluster-cidrs'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  invalidateRegistryEndpoint,
  registryHost,
  registryReachable,
} from '#drivers/k8s/container'
import { LABEL_REGISTRY_DATA_DIR_HASH, REGISTRY_UPSTREAM_IMAGE } from './project-registry'
import { env } from '@yaac/shared/env'
import { serverLog } from '#log'

/** `app` label on every object of the main registry. Distinct from the
 *  per-project registries' `app` value so neither feature's label selectors
 *  (GC sweeps, stray-pod reaps) can ever reach the other's objects. */
export const MAIN_REGISTRY_APP_LABEL = 'yaac-main-registry'

/** Marker label on the one-shot node-write pods, so the stray sweep can
 *  never select the registry Deployment's own pod. */
export const LABEL_MAIN_REGISTRY_NODE_WRITE = 'yaac.main-registry-node-write'

/**
 * Install-scoping labels. The hash carries the registry-scoped key rather
 * than the worktree one, for the same reason project-registry.ts uses it:
 * these objects must stay invisible to the worktree reaper and list paths.
 */
function mainRegistryLabels(): Record<string, string> {
  return {
    app: MAIN_REGISTRY_APP_LABEL,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/**
 * PVC backing the registry's blobs, keyed by install so coexisting installs
 * never share a store — the scoping the retired node hostPath got from
 * having `dataDirHash()` in its path.
 */
export function mainRegistryPvcName(): string {
  return `${REGISTRY_SERVICE_NAME}-storage-${dataDirHash()}`
}

/**
 * Requested capacity. It is a request, not a cap that anything here
 * enforces: kind's local-path provisioner ignores the number entirely (the
 * volume is a directory on the node's filesystem), so on the local backend
 * the real bound is the build-cache GC. It is sized for the backends where
 * it does bind — this store holds every worktree image of the install plus
 * every trust-split step-cache layer, and running it out of space fails
 * builds rather than degrading them.
 *
 * Raising it is safe; LOWERING it is not — see the note on
 * PROJECT_REGISTRY_STORAGE_SIZE, which this shares.
 */
export const MAIN_REGISTRY_STORAGE_SIZE = '100Gi'

/**
 * The blob store's claim. Deliberately names NO `storageClassName`, so it
 * binds through whatever the cluster's default class is: kind's
 * `standard` (rancher local-path) locally, the provider's default block
 * class on a stock cluster, and — inside a vcluster, where storage classes
 * are not synced in from the host — the host default the syncer's PVC
 * binds against. Naming a class here would break every cluster that does
 * not happen to ship it.
 *
 * Never deleted: it outlives Deployment rollouts by design, and the store
 * is only meant to die with the cluster (where it costs re-pushes, which is
 * why nothing backs it up).
 */
export function buildMainRegistryPvcManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: mainRegistryPvcName(),
      namespace: REGISTRY_NAMESPACE,
      labels: mainRegistryLabels(),
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: MAIN_REGISTRY_STORAGE_SIZE } },
    },
  }
}

/**
 * The registry Deployment. Trusted infra like the proxy and the project
 * registries, so no `runtimeClassName` — it runs on runc; the sentry buys
 * no containment for a yaac-pinned upstream and its CPU cost starves the
 * node. `Recreate`, because a rolling overlap would put two pods on one
 * store — and on a backend that enforces RWO across nodes it would simply
 * deadlock, the new pod waiting for a volume the old pod still holds.
 *
 * The image is the digest-pinned UPSTREAM ref rather than the local mirror
 * tag every other yaac pod uses: this registry cannot pull its own image
 * from itself. The node fetches it once (~25MB) and `IfNotPresent` keeps
 * every later rollout offline.
 */
export function buildMainRegistryDeploymentManifest(): Record<string, unknown> {
  const selector = { app: MAIN_REGISTRY_APP_LABEL }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: REGISTRY_SERVICE_NAME,
      namespace: REGISTRY_NAMESPACE,
      labels: mainRegistryLabels(),
    },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: mainRegistryLabels() },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // Infra tier: every worktree pod's image comes from here, so
          // evicting it to make room for a worktree is backwards.
          priorityClassName: PRIORITY_CLASS_INFRA,
          containers: [
            {
              name: 'registry',
              image: REGISTRY_UPSTREAM_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: REGISTRY_SERVICE_PORT }],
              readinessProbe: {
                httpGet: { path: '/v2/', port: REGISTRY_SERVICE_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [{ name: 'storage', mountPath: '/var/lib/registry' }],
            },
          ],
          volumes: [{
            name: 'storage',
            persistentVolumeClaim: { claimName: mainRegistryPvcName() },
          }],
        },
      },
    },
  }
}

/**
 * A normal selector-backed ClusterIP Service. Its allocator-assigned IP is
 * never pinned and never deleted, so `apply` is a no-op after first
 * creation and the hosts.toml written below stays valid across rollouts —
 * only a cluster recreate moves it.
 */
export function buildMainRegistryServiceManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: REGISTRY_SERVICE_NAME,
      namespace: REGISTRY_NAMESPACE,
      labels: mainRegistryLabels(),
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: MAIN_REGISTRY_APP_LABEL },
      // port == targetPort: nothing should have to reason about a remap.
      ports: [{
        name: 'registry',
        port: REGISTRY_SERVICE_PORT,
        targetPort: REGISTRY_SERVICE_PORT,
        protocol: 'TCP',
      }],
    },
  }
}

/**
 * The registry pod's ingress lock: exactly the two caller classes it has.
 *
 *  - **The node**, as an `ipBlock` — NetworkPolicy has no selector for the
 *    host network namespace, and three distinct things arrive from there:
 *    containerd pulling pushed refs via hosts.toml, the kubelet readiness
 *    probe, and the server's `kubectl port-forward`, which the kubelet
 *    dials into the pod.
 *  - **Builder pods, in any namespace** — hence `namespaceSelector: {}`
 *    beside the role selector, since a bare `podSelector` would match only
 *    this namespace and e2e runs put their builders in per-run ones. The
 *    role label is unforgeable: the builder-role ValidatingAdmissionPolicy
 *    lets no ServiceAccount set it.
 *
 * Worktree pods are deliberately absent. This does NOT stop a builder-origin
 * write (see the module header) — it stops everything that is not a builder
 * or the node from becoming a caller by accident.
 *
 * The node half is rendered from `nodeIpBlocks()` at ensure time, so it
 * goes STALE if node addresses move under it (a VM restart is the usual
 * cause) — and stale means node pulls are denied, since this fails closed.
 * The same is true of the per-project registries' locks and of the
 * hosts.toml beside them, and the fix is the same: `yaac cluster setup
 * --repair` re-renders all of it. Note the server's boot ensure does NOT
 * heal this, because it takes the cheap reachable-and-done path — the
 * registry is still reachable from the SERVER, which comes in over a
 * port-forward rather than from a node address. `cluster check`'s probe is
 * what surfaces it.
 */
export function buildMainRegistryIngressNetworkPolicyManifest(
  nodeCidrs: string[],
): Record<string, unknown> {
  const registryPort = { protocol: 'TCP', port: REGISTRY_SERVICE_PORT }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `${REGISTRY_SERVICE_NAME}-ingress`,
      namespace: REGISTRY_NAMESPACE,
      labels: mainRegistryLabels(),
    },
    spec: {
      podSelector: { matchLabels: { app: MAIN_REGISTRY_APP_LABEL } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: nodeCidrs.map((cidr) => ({ ipBlock: { cidr } })),
          ports: [registryPort],
        },
        {
          from: [{
            namespaceSelector: {},
            podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_BUILDER } },
          }],
          ports: [registryPort],
        },
      ],
    },
  }
}

/**
 * One-shot pod writing one node's containerd hosts.toml for the registry.
 * The hostPath is scoped to exactly the one `certs.d/<registry-host>`
 * directory, so the pod can affect no other registry's mapping. Pinned by
 * `nodeName` and `restartPolicy: Never` — the caller polls it to a terminal
 * phase.
 *
 * Tolerates everything, like netd and the gVisor installer. `nodeName`
 * bypasses the SCHEDULER, so a `NoSchedule` taint never mattered — but
 * kubelet still admits, and the taint manager still evicts, so a
 * `NoExecute` taint would refuse this pod on the very nodes it has to reach.
 * A node with no hosts.toml cannot pull, so the pods that most need this
 * write are exactly the ones a tainted worktrees pool would deny it to. The
 * blanket toleration costs nothing in scheduling freedom: the pod is pinned
 * to one named node and lives for seconds.
 *
 * It runs the same upstream `registry:2` the Deployment does, which the
 * rollout has already put on the node: the local mirror tag the project
 * registries' writers use lives in THIS registry, and nothing can pull from
 * it until this pod has run.
 */
export function buildMainRegistryHostsWriterPodManifest(
  nodeName: string,
  clusterIp: string,
  nodeIndex: number,
  runId: string,
): Record<string, unknown> {
  const content = `[host."http://${clusterIp}:${REGISTRY_SERVICE_PORT}"]`
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${REGISTRY_SERVICE_NAME}-hosts-${nodeIndex}-${runId}`,
      namespace: REGISTRY_NAMESPACE,
      labels: { ...mainRegistryLabels(), [LABEL_MAIN_REGISTRY_NODE_WRITE]: 'hosts' },
    },
    spec: {
      nodeName,
      // Trusted infra running a fixed yaac-authored script — no
      // runtimeClassName, so it runs on runc like the registry itself.
      restartPolicy: 'Never',
      tolerations: [{ operator: 'Exists' }],
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      priorityClassName: PRIORITY_CLASS_INFRA,
      containers: [{
        name: 'write',
        image: REGISTRY_UPSTREAM_IMAGE,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', `printf '%s\\n' '${content}' > /host-certs/hosts.toml`],
        volumeMounts: [{ name: 'certs', mountPath: '/host-certs' }],
      }],
      volumes: [{
        name: 'certs',
        hostPath: {
          path: `/etc/containerd/certs.d/${registryHost()}`,
          type: 'DirectoryOrCreate',
        },
      }],
    },
  }
}

interface RawNodeList {
  items: Array<{ metadata: { name: string } }>
}

/** Node names, for pinning the one-shot writer pods via `nodeName`. */
async function listNodeNames(): Promise<string[]> {
  const list = await kubectlGetJson<RawNodeList>(['get', 'nodes'])
  return (list?.items ?? []).map((n) => n.metadata.name)
}

/**
 * Write the node containerd hosts.toml mapping the registry's svc-DNS host
 * to its live ClusterIP on every node. The node is not a cluster-DNS
 * client, so it needs the IP; hosts.toml is read per-pull (no containerd
 * restart needed). Must run after the Service exists and the Deployment has
 * rolled out — the rollout is also what guarantees the writer pod's own
 * image is already on the node.
 */
export async function writeNodeMainRegistryHostsToml(): Promise<void> {
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', REGISTRY_SERVICE_NAME, '-n', REGISTRY_NAMESPACE,
  ])
  const clusterIp = svc?.spec?.clusterIP
  if (!clusterIp) {
    throw new Error(`registry Service ${REGISTRY_SERVICE_NAME} has no ClusterIP yet`)
  }
  // Reap writer pods left by crashed runs: the per-run name suffix means no
  // later namesake delete collects them. The node-write marker keeps the
  // registry Deployment's own pod out of the selector's reach.
  await kubectlWithRetry([
    'delete', 'pod', '-l', `app=${MAIN_REGISTRY_APP_LABEL},${LABEL_MAIN_REGISTRY_NODE_WRITE}`,
    '-n', REGISTRY_NAMESPACE, '--ignore-not-found',
  ])
  const runId = crypto.randomBytes(4).toString('hex')
  for (const [i, node] of (await listNodeNames()).entries()) {
    const manifest = buildMainRegistryHostsWriterPodManifest(node, clusterIp, i, runId)
    const name = (manifest as { metadata: { name: string } }).metadata.name
    const { phase, logs } = await runPodToCompletion(manifest, { timeoutMs: 120_000, pollMs: 500 })
    if (phase !== 'Succeeded') {
      throw new Error(
        `registry hosts.toml pod ${name} did not complete (phase ${phase})`
        + (logs.trim() ? `; logs: ${logs.trim()}` : ''),
      )
    }
  }
}

/** How long a fresh registry rollout may take, including the node's
 *  one-time upstream pull of the pinned registry:2. */
const ROLLOUT_TIMEOUT_MS = 300_000

/** The slice of a registry Deployment the conversion gate reads. */
interface RawRegistryDeploy {
  spec?: { template?: { spec?: { volumes?: Array<Record<string, unknown>> } } }
  status?: { readyReplicas?: number }
}

/** True when a Deployment's `storage` volume is a PVC rather than a hostPath. */
function specsClaimStorage(deploy: RawRegistryDeploy | null): boolean {
  const volumes = deploy?.spec?.template?.spec?.volumes
  if (!volumes) return false
  return volumes.some((v) => v.name === 'storage' && 'persistentVolumeClaim' in v)
}

async function readMainRegistryDeploy(): Promise<RawRegistryDeploy | null> {
  return kubectlGetJson<RawRegistryDeploy>([
    'get', 'deployment', REGISTRY_SERVICE_NAME, '-n', REGISTRY_NAMESPACE,
  ]).catch(() => null)
}

/**
 * Whether the Deployment's applied SPEC already stores on the PVC — false on
 * an install upgrading from the node-hostPath store, and false when there is
 * no Deployment to read at all (in which case the ensure below is what
 * creates one).
 *
 * The cheap reachable-and-done path consults this because the upgrade is
 * otherwise invisible to it: the OLD registry answers perfectly well, so a
 * reachability check alone would leave it on its hostPath forever.
 *
 * Spec, deliberately, and only sound for that caller: it reaches here having
 * already established the registry ANSWERS, so a spec that names the claim
 * is a claim something is serving from.
 *
 * One `kubectl get`, and it fails SAFE: an unreadable or absent Deployment
 * answers false, which costs a redundant apply.
 */
export async function mainRegistryStorageIsClaim(): Promise<boolean> {
  return specsClaimStorage(await readMainRegistryDeploy())
}

export interface EnsureMainRegistryOptions {
  /**
   * Apply everything even when the registry already answers from its claim.
   * `yaac cluster setup` (both modes) passes this — `--repair` exists
   * precisely to re-write wiring that a node or VM restart may have dropped
   * — while the server's boot ensure takes the cheap path.
   */
  force?: boolean
}

/**
 * Idempotently stand the registry up (PVC + Deployment + Service + ingress
 * lock + node hosts.toml) and wait until this process can reach it.
 *
 * Refuses to create anything when the registry is EXTERNALLY managed —
 * `YAAC_K8S_REGISTRY` set, of which a nested yaac (pointed at the outer
 * install's per-project registry) is the production case. The guard is on
 * the variable rather than on `YAAC_NESTED` because the damage is not
 * nesting-specific: `registryHost()` is the external host, so an install
 * here would write a node hosts.toml at
 * `/etc/containerd/certs.d/<external-host>` aiming that host's pulls at a
 * local ClusterIP — silently hijacking node-side resolution of someone
 * else's registry.
 */
export async function ensureMainRegistry(opts: EnsureMainRegistryOptions = {}): Promise<void> {
  const external = env.k8sRegistry
  if (!opts.force && await registryReachable()) {
    // An EXTERNAL registry's storage is not this install's to convert, and
    // the Deployment the claim check reads lives in a cluster that has no
    // such object — a nested yaac's own vcluster. Asking would answer "not
    // converted" forever and drop a healthy install into the throw below,
    // whose message ("not answering") would be flatly untrue.
    if (external || await mainRegistryStorageIsClaim()) return
  }

  if (external) {
    throw new Error(
      `Registry ${external} is not answering. It is externally managed `
      + '(YAAC_K8S_REGISTRY is set'
      + (env.nested ? '; nested yaac uses the outer per-project registry' : '')
      + ') — yaac will not stand up a replacement for it.',
    )
  }

  serverLog(`[registry] ensuring the in-cluster registry ${registryHost()}`)
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Namespace',
    // Privileged PSS: this namespace also holds the node-write pods that
    // hostPath-mount a node's certs.d, which an adopted cluster's
    // baseline/restricted default would reject at admission.
    metadata: { name: REGISTRY_NAMESPACE, labels: { ...PRIVILEGED_PSS_LABELS } },
  })
  // Before the Deployment that mounts it. Applying it second would still
  // converge (the pod just stays Pending until the claim exists), but the
  // rollout wait below would spend that time looking like a scheduling
  // failure.
  await kubectlApply(buildMainRegistryPvcManifest())
  await kubectlApply(buildMainRegistryDeploymentManifest())
  await kubectlApply(buildMainRegistryServiceManifest())
  await kubectlApply(buildMainRegistryIngressNetworkPolicyManifest(await nodeIpBlocks()))
  try {
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${REGISTRY_SERVICE_NAME}`, '-n', REGISTRY_NAMESPACE,
      `--timeout=${Math.floor(ROLLOUT_TIMEOUT_MS / 1000)}s`,
    ], { timeout: ROLLOUT_TIMEOUT_MS + 10_000, maxAttempts: 2 })
  } catch (err) {
    // kubectl reports only that it timed out, and the diagnoses that matter
    // are all one command away. The PVC is named alongside the pods because
    // a cluster with no DEFAULT StorageClass leaves the claim Pending
    // forever, which shows up as a Pending pod with no scheduling reason of
    // its own.
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n`
      + `Inspect with \`kubectl -n ${REGISTRY_NAMESPACE} get pods,pvc `
      + `-l app=${MAIN_REGISTRY_APP_LABEL}\` — Pending means the node had no `
      + 'room, ImagePullBackOff means it could not fetch the pinned '
      + 'registry:2 from upstream, and a Pending PVC means the cluster has '
      + 'no default StorageClass to bind it.',
    )
  }
  await writeNodeMainRegistryHostsToml()

  // A rolled-out Deployment is not the same as a reachable one from HERE:
  // the port-forward is this process's only route to it, and a stale child
  // from a previous incarnation would still be cached.
  invalidateRegistryEndpoint()
  for (let i = 0; i < 20; i++) {
    if (await registryReachable()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`In-cluster registry ${registryHost()} did not become reachable from the server`)
}

/**
 * Run one argv inside the registry container — the in-cluster replacement
 * for `podman exec yaac-registry`, used by the step-cache collect
 * (features/images/build-cache-gc.ts) to walk and prune the registry's own
 * storage layout. `deploy/<name>` lets kubectl pick the Deployment's pod,
 * so nothing here tracks pod names.
 */
export async function mainRegistryExec(argv: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await kubectlWithRetry(
    ['exec', '-n', REGISTRY_NAMESPACE, `deploy/${REGISTRY_SERVICE_NAME}`, '--', ...argv],
    { timeout: timeoutMs, maxAttempts: 1 },
  )
  return stdout
}

/**
 * Bounce the registry, which is how its in-memory blob descriptors are
 * cleared after a garbage collect (a re-pushed digest would otherwise write
 * a link with no blob behind it and 404 forever).
 *
 * The Service's ClusterIP survives, so no hosts.toml rewrite is owed — but
 * this process's port-forward was bound to the pod that just went away, so
 * it is dropped and re-established on next use.
 *
 * `Recreate` means the old pod is gone before the replacement is scheduled,
 * so the replacement may well land on a different node. That is now
 * uneventful: the blobs are on the PVC, which the new pod mounts, so the
 * catalog the collect just pruned is the catalog that comes back.
 */
export async function restartMainRegistry(): Promise<void> {
  await kubectlWithRetry([
    'rollout', 'restart', `deployment/${REGISTRY_SERVICE_NAME}`, '-n', REGISTRY_NAMESPACE,
  ], { maxAttempts: 2 })
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${REGISTRY_SERVICE_NAME}`, '-n', REGISTRY_NAMESPACE,
    '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 2 })
  invalidateRegistryEndpoint()
}
