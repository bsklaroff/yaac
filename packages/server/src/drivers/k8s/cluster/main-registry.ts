/**
 * The install's main OCI registry as an in-cluster workload: the one image
 * bus (docs/trust-split-builds.md). Host `podman build` and sandboxed
 * builder pods push to it, and node containerd pulls every workspace image
 * from it. Same shape as the per-project registries (project-registry.ts):
 * digest-pinned `registry:2`, a Recreate Deployment, a ClusterIP Service,
 * an RWO PVC, and per-node containerd `hosts.toml` written by one-shot pods.
 *
 * Differences, since this one is install-wide:
 *  - It lives in the default namespace (`REGISTRY_NAMESPACE`), so per-run
 *    e2e namespaces share one image store.
 *  - Its pods use upstream digest refs, since it cannot pull its own images.
 *  - Writes need a signed grant, checked by the write gate in front of it
 *    (registry-gate.ts). Builder pods run untrusted `RUN` steps yet must
 *    push, so the gate scopes each write to allowed repositories.
 *  - Its ingress policy admits the node, builder pods in any namespace, and
 *    the in-cluster server. Workspace pods cannot reach it (their egress
 *    policy only allows netd).
 *
 * Host processes reach it through a `kubectl port-forward`; see
 * `#drivers/k8s/container`'s registry module.
 *
 * Storage is an RWO PVC, so a reschedule takes the store along. One
 * replica with `Recreate` means one mounter at a time. If no default
 * StorageClass exists the claim never binds and the registry stays down;
 * `cluster install` reports that. Losing the volume only costs re-pushes.
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
  SERVER_APP_NAME,
  runPodToCompletion,
} from '#drivers/k8s/substrate'
import { nodeIpBlocks } from './cluster-cidrs'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  invalidateRegistryEndpoint,
  registryGrantPublicKey,
  registryHost,
  registryReachable,
} from '#drivers/k8s/container'
import { LABEL_REGISTRY_DATA_DIR_HASH, REGISTRY_UPSTREAM_IMAGE } from './project-registry'
import { ENVOY_UPSTREAM_IMAGE } from './netd'
import {
  REGISTRY_BACKEND_PORT,
  REGISTRY_GATE_CONFIG_DIR,
  registryGateBootstrap,
} from './registry-gate'
import { serverLog } from '#log'

/** `app` label for the main registry's objects, distinct from the project
 *  registries' so neither's selectors match the other. */
export const MAIN_REGISTRY_APP_LABEL = 'yaac-main-registry'

/** Label on the one-shot node-write pods, so the stray sweep never selects
 *  the registry's own pod. */
export const LABEL_MAIN_REGISTRY_NODE_WRITE = 'yaac.main-registry-node-write'

/** Install-scoping labels, using the registry hash key so the workspace
 *  reaper and listings never see these objects. */
function mainRegistryLabels(): Record<string, string> {
  return {
    app: MAIN_REGISTRY_APP_LABEL,
    [LABEL_REGISTRY_DATA_DIR_HASH]: dataDirHash(),
  }
}

/** The blob PVC's name, keyed by install so installs never share one. */
export function mainRegistryPvcName(): string {
  return `${REGISTRY_SERVICE_NAME}-storage-${dataDirHash()}`
}

/**
 * Requested PVC size. kind's local-path provisioner ignores it (GC is the
 * real bound there, docs/image-gc.md); other backends enforce it, and a full
 * store fails builds. Raising it is safe; lowering it is not (see
 * PROJECT_REGISTRY_STORAGE_SIZE).
 */
export const MAIN_REGISTRY_STORAGE_SIZE = '100Gi'

/**
 * The blob store's claim. No `storageClassName`, so it uses the cluster's
 * default class. Never deleted; it lives as long as the cluster.
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

/** Name of the write gate's ConfigMap (and of its container in the pod). */
const REGISTRY_GATE_NAME = `${REGISTRY_SERVICE_NAME}-gate`

/** The gate's Envoy bootstrap, rendered around the grant key's public half. */
export function buildMainRegistryGateConfigMapManifest(publicKeyDer: Buffer): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: REGISTRY_GATE_NAME,
      namespace: REGISTRY_NAMESPACE,
      labels: mainRegistryLabels(),
    },
    data: { 'bootstrap.json': registryGateBootstrap(REGISTRY_SERVICE_PORT, publicKeyDer) },
  }
}

/**
 * The registry Deployment: `registry:2` on loopback behind the write gate
 * (registry-gate.ts) on the Service port. Trusted infra, so it runs on runc,
 * not gVisor. `Recreate` avoids two pods on one RWO volume.
 *
 * A hash of the gate config in the template rolls the pod when the key or
 * gate changes (Envoy reads its bootstrap only at start). Readiness is
 * probed through the gate with an empty Basic credential, since the gate
 * challenges a bare `/v2/` (which is what makes podman send its grant).
 */
export function buildMainRegistryDeploymentManifest(publicKeyDer: Buffer): Record<string, unknown> {
  const selector = { app: MAIN_REGISTRY_APP_LABEL }
  const gateConfigHash = crypto.createHash('sha256')
    .update(registryGateBootstrap(REGISTRY_SERVICE_PORT, publicKeyDer))
    .digest('hex').slice(0, 16)
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
        metadata: {
          labels: mainRegistryLabels(),
          annotations: { 'yaac.registry-gate-config': gateConfigHash },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // Every workspace image comes from here.
          priorityClassName: PRIORITY_CLASS_INFRA,
          containers: [
            {
              name: 'registry',
              image: REGISTRY_UPSTREAM_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              env: [{ name: 'REGISTRY_HTTP_ADDR', value: `127.0.0.1:${String(REGISTRY_BACKEND_PORT)}` }],
              volumeMounts: [{ name: 'storage', mountPath: '/var/lib/registry' }],
            },
            {
              name: 'gate',
              image: ENVOY_UPSTREAM_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 101,
                runAsGroup: 101,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              command: ['envoy', '-c', `${REGISTRY_GATE_CONFIG_DIR}/bootstrap.json`, '--log-level', 'warn'],
              ports: [{ containerPort: REGISTRY_SERVICE_PORT }],
              readinessProbe: {
                httpGet: {
                  path: '/v2/',
                  port: REGISTRY_SERVICE_PORT,
                  httpHeaders: [{ name: 'Authorization', value: 'Basic Og==' }],
                },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [{ name: 'gate-config', mountPath: REGISTRY_GATE_CONFIG_DIR, readOnly: true }],
            },
          ],
          volumes: [
            { name: 'storage', persistentVolumeClaim: { claimName: mainRegistryPvcName() } },
            { name: 'gate-config', configMap: { name: REGISTRY_GATE_NAME } },
          ],
        },
      },
    },
  }
}

/**
 * The registry Service. Never deleted, so its ClusterIP (and the hosts.toml
 * naming it) stays valid across rollouts.
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
 * The registry's ingress policy. Allowed callers:
 *  - The node, by `ipBlock` (containerd pulls, the kubelet probe, and
 *    `kubectl port-forward`).
 *  - Builder pods in any namespace (e2e runs use per-run namespaces). The
 *    role label cannot be forged; the builder-role admission policy blocks
 *    it.
 *  - The in-cluster server, in any namespace (docs/server-in-cluster.md).
 * Workspace pods are not allowed. What builders may write is limited by the
 * write gate, not this policy.
 *
 * Node addresses are rendered at ensure time, so a node address change
 * (e.g. VM restart) denies node pulls until `yaac cluster install` runs
 * again. The server's boot ensure does not catch this; `cluster check`
 * does.
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
        {
          from: [{
            namespaceSelector: {},
            podSelector: { matchLabels: { app: SERVER_APP_NAME } },
          }],
          ports: [registryPort],
        },
      ],
    },
  }
}

/**
 * One-shot pod, pinned by `nodeName`, that writes one node's containerd
 * hosts.toml for the registry. Its hostPath is only that registry's
 * `certs.d` dir.
 *
 * Tolerates every taint: `nodeName` skips the scheduler but a `NoExecute`
 * taint would still evict it, and tainted workspace nodes need the file
 * most. Runs the upstream `registry:2` image, which the rollout already put
 * on the node, since nothing can pull from this registry before the file
 * exists.
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
      // Trusted infra: runs on runc.
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
  // Remove writer pods left by crashed runs (names are per run).
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

/** Rollout timeout, including the first upstream image pulls. */
const ROLLOUT_TIMEOUT_MS = 300_000

/** After this long, check for the `arp_ignore` misconfiguration below. */
const ROLLOUT_STALL_MS = 60_000

/** How long a rolled-out registry may take to answer a dial (e.g. while a
 *  restarted node's pod network comes back). */
const REACHABLE_TIMEOUT_MS = 90_000

async function waitForRegistryRollout(timeoutMs: number): Promise<void> {
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${REGISTRY_SERVICE_NAME}`, '-n', REGISTRY_NAMESPACE,
    `--timeout=${Math.floor(timeoutMs / 1000)}s`,
  ], { timeout: timeoutMs + 10_000, maxAttempts: 2 })
}

/**
 * Throw an actionable error if the registry pod's netns has `arp_ignore` 2
 * or 8. Calico gives pods a /32, so the node could never resolve the pod
 * and every probe times out. New netns copy this from the host's root netns
 * (a VPN client may set it); `devconf_inherit_init_net=3` makes them copy
 * the kind node's instead. Does nothing if the pod cannot be exec'd into.
 */
async function refuseArpIgnoringPodNetns(): Promise<void> {
  let out: string
  try {
    out = await mainRegistryExec(
      ['cat', '/proc/sys/net/ipv4/conf/all/arp_ignore', '/proc/sys/net/ipv4/conf/eth0/arp_ignore'],
      15_000,
    )
  } catch {
    return
  }
  // The kernel applies the larger of the `all` and per-interface values.
  const arpIgnore = Math.max(...out.split(/\s+/).filter(Boolean).map(Number))
  if (arpIgnore !== 2 && arpIgnore !== 8) return
  throw new Error(
    'The in-cluster registry pod is running but never becomes ready: its network namespace has '
    + `net.ipv4.conf.all.arp_ignore=${arpIgnore}, so it never answers the node's ARP and the `
    + 'kubelet cannot reach it. New pod namespaces copy that setting from this host\'s root '
    + 'namespace, where something (a VPN client, for instance) has set it. Make new namespaces '
    + 'copy from the kind node instead, then recreate the cluster — every pod created so far '
    + 'already has the setting:\n'
    + '  sudo sysctl -w net.core.devconf_inherit_init_net=3\n'
    + '  yaac cluster delete\n'
    + '  yaac cluster install\n'
    + 'To keep the setting across reboots:\n'
    + '  echo \'net.core.devconf_inherit_init_net = 3\' | sudo tee /etc/sysctl.d/90-yaac-netns.conf',
  )
}

export interface EnsureMainRegistryOptions {
  /**
   * Apply everything even if the registry already answers. `yaac cluster
   * install` sets this to rewrite wiring a node or VM restart may have
   * lost; the server's boot ensure does not.
   */
  force?: boolean
}

/**
 * Idempotently stand the registry up (PVC + Deployment + Service + ingress
 * lock + node hosts.toml) and wait until this process can reach it.
 */
export async function ensureMainRegistry(opts: EnsureMainRegistryOptions = {}): Promise<void> {
  if (!opts.force && await registryReachable()) return

  serverLog(`[registry] ensuring the in-cluster registry ${registryHost()}`)
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Namespace',
    // Privileged PSS for the node-write pods' hostPath mounts.
    metadata: { name: REGISTRY_NAMESPACE, labels: { ...PRIVILEGED_PSS_LABELS } },
  })
  // Before the Deployment that mounts it.
  await kubectlApply(buildMainRegistryPvcManifest())
  // Creates the grant key on first use; the gate gets the public half.
  const publicKeyDer = await registryGrantPublicKey()
  await kubectlApply(buildMainRegistryGateConfigMapManifest(publicKeyDer))
  await kubectlApply(buildMainRegistryDeploymentManifest(publicKeyDer))
  await kubectlApply(buildMainRegistryServiceManifest())
  await kubectlApply(buildMainRegistryIngressNetworkPolicyManifest(await nodeIpBlocks()))
  const rolledOut = await waitForRegistryRollout(ROLLOUT_STALL_MS).then(() => true, () => false)
  if (!rolledOut) {
    await refuseArpIgnoringPodNetns()
    try {
      await waitForRegistryRollout(ROLLOUT_TIMEOUT_MS - ROLLOUT_STALL_MS)
    } catch (err) {
      // kubectl only says it timed out; point at the likely causes.
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n`
        + `Inspect with \`kubectl -n ${REGISTRY_NAMESPACE} get pods,pvc `
        + `-l app=${MAIN_REGISTRY_APP_LABEL}\` — Pending means the node had no `
        + 'room, ImagePullBackOff means it could not fetch the pinned '
        + 'registry:2 or Envoy from upstream, and a Pending PVC means the cluster has '
        + 'no default StorageClass to bind it.',
      )
    }
  }
  await writeNodeMainRegistryHostsToml()

  // Rolled out is not reachable: a cached port-forward may be stale, and
  // after a node restart the pod can read Available before its network is
  // up. So drop the cached endpoint and wait for an actual dial.
  invalidateRegistryEndpoint()
  const deadline = Date.now() + REACHABLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await registryReachable()) return
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`In-cluster registry ${registryHost()} did not become reachable from the server`)
}

/**
 * Run a command in the registry container, for the step-cache collect
 * (`#drivers/k8s/images` main-registry-gc.ts). `deploy/<name>` lets kubectl
 * pick the pod.
 */
export async function mainRegistryExec(argv: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await kubectlWithRetry(
    ['exec', '-n', REGISTRY_NAMESPACE, `deploy/${REGISTRY_SERVICE_NAME}`, '-c', 'registry', '--', ...argv],
    { timeout: timeoutMs, maxAttempts: 1 },
  )
  return stdout
}

/**
 * Restart the registry after a garbage collect to clear its in-memory blob
 * cache (otherwise a re-pushed digest 404s forever). The ClusterIP survives,
 * but a port-forward to the old pod must be re-established. The blobs are
 * on the PVC, so the new pod may land on any node.
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
