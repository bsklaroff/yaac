/**
 * The install's main OCI registry, as an in-cluster workload.
 *
 * This is the one image bus (docs/trust-split-builds.md): host-side
 * `podman build` pushes trusted layers into it, sandboxed builder pods pull
 * their parents from it and push their products back, node containerd pulls
 * every session image from it, and the vcluster chart's images are named
 * through it. It is deliberately the SAME topology as the per-project
 * registries (project-registry.ts) rather than a second pattern:
 * digest-pinned `registry:2`, a Recreate Deployment, a selector-backed
 * ClusterIP Service, node-local hostPath storage, and a per-node containerd
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
 *    one project's sessions. Session pods are not on that list and cannot
 *    reach it anyway — their own default-deny egress
 *    (`buildSessionEgressNpManifest`) admits nothing but the node's netd
 *    listener range. Note the world-deny policy is NOT what stops them: it
 *    explicitly excludes session-labeled pods.
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
 * networking assumption — see `#platform/container`'s registry module for
 * the cluster-ref vs process-endpoint split.
 *
 * Storage is a node hostPath, exactly as the per-project registries store
 * theirs; converting both to a PVC is the stock-multi-node follow-up
 * (docs/plans/stock-k8s-multi-node.md §5). Until then the store is
 * node-local while the Deployment is unpinned, and on a multi-node cluster
 * that costs three things rather than the one it looks like:
 *
 *  - A reschedule lands the registry on an EMPTY store, so every pushed
 *    image has to be re-pushed. Self-healing (`registryHasTag` misses and
 *    the pushers retry) but surprising.
 *  - The store it LEFT is stranded: a full copy of the images, on a node
 *    nothing will prune, since `build-cache-gc` only ever reaches the
 *    store of the pod it can `kubectl exec` into. Several GB per move.
 *  - `restartMainRegistry` is itself a reschedule opportunity, so the
 *    build-cache collect that ends in one can come back serving a
 *    DIFFERENT store — see the note on `BuildCacheGcResult.restored`.
 *
 * All three want the same fix, and it is not a `nodeSelector`: pinning
 * trades a self-healing degradation for a single point of failure, on
 * exactly the store a node replacement destroys.
 */
import crypto from 'node:crypto'
import {
  LABEL_ROLE,
  PRIORITY_CLASS_INFRA,
  ROLE_BUILDER,
  dataDirHash,
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
} from '#platform/k8s'
import { nodeIpBlocks } from './cluster-cidrs'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  ensureRootfulPodmanHost,
  invalidateRegistryEndpoint,
  registryHost,
  registryReachable,
} from '#platform/container'
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
 * Node-local hostPath backing the registry's blobs, keyed by install so
 * coexisting installs never share a store. Node-local (not under the data
 * dir) for the same reason the project registries are: registry blob
 * layouts are hostile to virtiofs, and losing them on a cluster recreate
 * only costs re-pushes.
 */
export function mainRegistryStorageHostPath(): string {
  return `/var/lib/yaac/main-registry/${dataDirHash()}`
}

/**
 * Install-scoping labels. The hash carries the registry-scoped key rather
 * than the session one, for the same reason project-registry.ts uses it:
 * these objects must stay invisible to the session reaper and list paths.
 */
function mainRegistryLabels(): Record<string, string> {
  return {
    app: MAIN_REGISTRY_APP_LABEL,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/**
 * The registry Deployment. Trusted infra like the proxy and the project
 * registries, so no `runtimeClassName` — it runs on runc; the sentry buys
 * no containment for a yaac-pinned upstream and its CPU cost starves the
 * node. `Recreate`, because two pods would race over the node-local
 * storage hostPath during a rolling overlap.
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
          // Infra tier: every session pod's image comes from here, so
          // evicting it to make room for a session is backwards.
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
            hostPath: { path: mainRegistryStorageHostPath(), type: 'DirectoryOrCreate' },
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
 * Session pods are deliberately absent. This does NOT stop a builder-origin
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
 * `nodeName` (bypasses the scheduler, so taints cannot strand it) and
 * `restartPolicy: Never` — the caller polls it to a terminal phase.
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

export interface EnsureMainRegistryOptions {
  /**
   * Apply everything even when the registry already answers. `yaac cluster
   * setup` (both modes) passes this — `--repair` exists precisely to
   * re-write wiring that a node or VM restart may have dropped — while the
   * server's boot ensure takes the cheap reachable-and-done path.
   */
  force?: boolean
}

/**
 * Name of the EndpointSlice the pre-in-cluster registry's SELECTORLESS
 * Service was backed by. It is hand-written (no `managed-by`, so the
 * endpoint-slice controller never touches it) and carries this Service's
 * `kubernetes.io/service-name` label, so on an upgraded cluster it survives
 * the apply that converts the Service to a selector-backed one — and
 * kube-proxy UNIONS every slice of a Service, which would leave the
 * ClusterIP load-balancing between the new registry pod and the dead podman
 * container's old address. Deleted on every ensure.
 */
const LEGACY_ENDPOINTSLICE_NAME = `${REGISTRY_SERVICE_NAME}-1`

/**
 * Host podman container the pre-in-cluster registry ran as — same name as
 * the Service, published on 127.0.0.1:5001 and joined to the podman `kind`
 * network.
 */
const LEGACY_REGISTRY_CONTAINER = REGISTRY_SERVICE_NAME

/**
 * One-time migration for an install upgrading from the host-podman
 * registry: remove that container once the in-cluster replacement is
 * serving.
 *
 * It is otherwise unreachable garbage — nothing on this code path names it,
 * and `cluster delete` no longer removes it (one `kind delete` takes the
 * in-cluster registry with the node), so without this it would outlive the
 * install it belonged to, holding its image and blob layer and a published
 * loopback port.
 *
 * Runs on the ensure that CREATES the registry, which is every upgrade path
 * into it: `cluster setup` (both modes, which force) and the server's boot
 * ensure, whose cheap reachable-and-done path returns before this on every
 * later run. `--ignore` makes an absent container a no-op, so a fresh
 * install pays one podman call and logs nothing.
 *
 * Never fatal: the registry that matters is already up by here, and the
 * worst case of a failure is the stopped container the message says how to
 * remove.
 */
async function removeLegacyRegistryContainer(): Promise<void> {
  // Which engine holds it is not ambient: the legacy container was created
  // on the ROOTFUL engine (it shared kind's), and a podman call that lands
  // on the rootless one would report success having looked in the wrong
  // place. Idempotent, and honours a CONTAINER_HOST already set.
  ensureRootfulPodmanHost()
  try {
    const { stdout } = await execFileAsync('podman', [
      'rm', '-f', '--ignore', LEGACY_REGISTRY_CONTAINER,
    ])
    // `--ignore` prints nothing when there was no such container, so this
    // line appears exactly once per upgraded install.
    if (stdout.trim()) {
      serverLog(
        '[registry] removed the legacy host registry container '
        + `${LEGACY_REGISTRY_CONTAINER}; the in-cluster registry replaces it`,
      )
    }
  } catch (err) {
    serverLog(
      `[registry] could not remove the legacy ${LEGACY_REGISTRY_CONTAINER} container `
      + `(remove it with \`podman rm -f ${LEGACY_REGISTRY_CONTAINER}\`): ${String(err)}`,
    )
  }
}

/**
 * Idempotently stand the registry up (Deployment + Service + ingress lock +
 * node hosts.toml) and wait until this process can reach it.
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
  if (!opts.force && await registryReachable()) return

  const external = env.k8sRegistry
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
    metadata: { name: REGISTRY_NAMESPACE },
  })
  // Before the Service apply that would otherwise inherit it.
  await kubectlWithRetry([
    'delete', 'endpointslice', LEGACY_ENDPOINTSLICE_NAME,
    '-n', REGISTRY_NAMESPACE, '--ignore-not-found',
  ]).catch((err: unknown) => {
    serverLog(`[registry] could not drop the legacy EndpointSlice: ${String(err)}`)
  })
  await kubectlApply(buildMainRegistryDeploymentManifest())
  await kubectlApply(buildMainRegistryServiceManifest())
  await kubectlApply(buildMainRegistryIngressNetworkPolicyManifest(await nodeIpBlocks()))
  try {
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${REGISTRY_SERVICE_NAME}`, '-n', REGISTRY_NAMESPACE,
      `--timeout=${Math.floor(ROLLOUT_TIMEOUT_MS / 1000)}s`,
    ], { timeout: ROLLOUT_TIMEOUT_MS + 10_000, maxAttempts: 2 })
  } catch (err) {
    // kubectl reports only that it timed out, and the two diagnoses that
    // matter (Pending vs ImagePullBackOff on the upstream registry:2 pull)
    // are both one command away.
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n`
      + `Inspect with \`kubectl -n ${REGISTRY_NAMESPACE} get pods `
      + `-l app=${MAIN_REGISTRY_APP_LABEL}\` — Pending means the node had no `
      + 'room, ImagePullBackOff means it could not fetch the pinned '
      + 'registry:2 from upstream.',
    )
  }
  await writeNodeMainRegistryHostsToml()
  // Only now that the replacement is rolled out and the nodes point at it.
  await removeLegacyRegistryContainer()

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
