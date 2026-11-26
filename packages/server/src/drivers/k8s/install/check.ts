import {
  apiserverEndpoints,
  buildRegistrationConfigMapManifest,
  ensureUtilityImage,
  ensureNamespace,
  mountdImage,
  nodeIpBlocks,
  npmCacheHost,
  proxyRegistrationName,
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  registryEndpoint,
  registryHost,
  registryPodEndpoint,
  registryReachable,
  servingNpmCacheUrl,
  siteCloudflareStatus,
  siteTailnetDevice,
  siteTailnetStatus,
  vapAvailable,
} from '#drivers/k8s/cluster'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import { isIP } from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  EGRESS_WORLD_DENY_NAME,
  GLOBAL_CLAIM_NAME,
  LABEL_CLAIM,
  LABEL_INSTALL_ID,
  LABEL_ROLE,
  LABEL_WORKSPACE_ID,
  NETD_APP_NAME,
  NETD_SITE_PORT,
  NETD_STREAM_PORT,
  NFS_PORT,
  NPM_CACHE_APP_NAME,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_PORT,
  SERVER_APP_NAME,
  SITE_ROUTER_APP_NAME,
  SITE_ROUTER_TAILNET_PORT,
  SITE_TUNNEL_CLOUDFLARE_APP_NAME,
  SITE_TUNNEL_TAILNET_APP_NAME,
  SITE_TUNNEL_TAILNET_TLS_SECRET_NAME,
  PROXY_EGRESS_NP_NAME,
  ROLE_SERVER,
  SERVER_EGRESS_NP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  VOLUMES_CLAIM_NAME,
  SERVER_POD_PORT,
  RUNTIME_CLASS_GVISOR,
  SANDBOX_DNS,
  applyObject,
  buildPriorityClassManifests,
  currentKubeContext,
  installId,
  deleteObject,
  ensureKubernetes,
  execFileAsync,
  formatTaint,
  k8sErrorSummary,
  k8sNamespace,
  listObjects,
  readObject,
  runPodToCompletion,
  installSecurityContext,
  netshimContainer,
  socketVolume,
  untoleratedTaints,
  GVISOR_NODE_LABEL,
  WORKSPACE_POOL_KEY,
  nodeLocalNodePath,
  runOnEachNode,
} from '#drivers/k8s/substrate'
import type { InstallIdentity, NodeTaint, PodToleration } from '#drivers/k8s/substrate'
import { tokenEndpointCheck } from './token-endpoint'
import { GVISOR_INSTALLER_APP_NAME } from './gvisor-installer'
import { deployedInstallIdentity } from './server-deploy'
import { kindClusterExists } from './delete'
import { isNfsFamily } from './storage'
import { YAAC_CLUSTER_INSTALL } from './arg-guards'
import {
  hostNodeArchitecture,
  nodeArchitectureProblems,
  nodeOsProblems,
  type PlatformNode,
} from './byo-gates'
import { readInstallRecord } from '@yaac/shared/install-record'
import { pushImageToRegistry } from './host-images'
import { PACKAGE_ROOT, globalRoot, serverLocalRoot, volumesRoot } from '@yaac/shared/paths'
import type { CheckResult } from '@yaac/shared/types'
import { runMountdProbe } from './mountd-gate'

/** Probe image used for the end-to-end registry-pull + hostPath check. */
const PROBE_SOURCE_IMAGE = 'docker.io/library/busybox:1.36'
const PROBE_LOCAL_TAG = 'yaac-cluster-probe:busybox-1.36'
const PROBE_POD_NAME = 'yaac-cluster-check'

const KIND_SETUP_FIX = [
  'Create a kind cluster wired for yaac — or restart one a host reboot',
  'left stopped — by running:',
  '  yaac cluster install',
  'It provisions the podman machine (macOS), the kind cluster (data dir and',
  'node-local extraMounts), Calico, the kind node fixups, every built-in',
  'image, the in-cluster registry, and the storage claims.',
].join('\n')

/**
 * Why the API server did not answer. A host with no kubeconfig context, or
 * one naming a kind cluster podman's kind does not have, gets that said plainly: otherwise
 * the cause is client-node's error from dialing a stand-in address, which
 * reads like a TLS problem. Anything else, such as a node left stopped by a
 * reboot, reports the cause ensureKubernetes puts on its last line.
 */
async function unreachableDetail(err: unknown): Promise<string> {
  try {
    const context = currentKubeContext()
    if (context === null) return 'no cluster configured (no kubeconfig context)'
    const kind = context.startsWith('kind-') ? context.slice('kind-'.length) : null
    if (kind !== null && !await kindClusterExists(kind)) return `no kind cluster ${kind} under podman`
  } catch { /* an unreadable kubeconfig or no kind: report the raw cause */ }
  return `API server unreachable (${(err as Error).message.split('\n').pop() ?? ''})`
}

/**
 * The kind node container's pids limit, which install applies and the
 * node-fixups check verifies. Node-level tuning that the installer
 * DaemonSet can apply lives in node-tuning.ts instead.
 */
export const NODE_PIDS_LIMIT = 32768

/**
 * Run the full preflight suite for the Kubernetes backend. Returns every
 * result, and `ok: false` when any check failed. Roughly in order:
 *
 * - kubectl present (for `kubectl exec` and port-forwards) and the API
 *   server reachable (either failing stops the run).
 * - nodes: how many can take a workspace, whether all are Ready, and the
 *   `architecture` and `node-os` gates `--byo` installs on.
 * - podman present; the in-cluster registry answering; the namespace.
 * - storage: every claim Bound, `Retain`, and the right backing.
 * - PriorityClasses present.
 * - node-fixups (kind only, warn): the node container's pids limit.
 * - gvisor: the RuntimeClass exists, a node is labeled, and a pod on it
 *   really is sandboxed. gvisor-installer (warn): the installer DaemonSet
 *   is Ready on every node, which it only is once runsc and the node tuning
 *   are in place.
 * - Pod probes, run concurrently: the end-to-end probe (registry pull and
 *   the global claim shared with a peer pod), mountd's bind into a
 *   sandbox, egress (NetworkPolicy enforced between yaac's own pods, a
 *   sandbox reaching nothing but its allowlist through the socket
 *   datapath, and the server's own egress), the npm cache through the
 *   proxy, the site edge's wall (and, with a tunnel, its connection), a pod
 *   on every node of a multi-node cluster (warn), and storage semantics.
 * - datapath: netd, whose relay carries every sandbox's traffic, Ready.
 * - vap: ValidatingAdmissionPolicy available (builds need it).
 *
 * Once a check fails, the pod-based gates that depend on it are skipped.
 */
export async function runClusterCheck(
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const add = (r: CheckResult): void => { results.push(r) }

  try {
    await execFileAsync('kubectl', ['version', '--client', '--output', 'json'])
    add({ name: 'kubectl', status: 'pass', detail: 'installed (for exec and port-forward streams)' })
  } catch {
    add({
      name: 'kubectl', status: 'fail', detail: 'not found on PATH — yaac streams into pods with `kubectl exec`',
      fix: process.platform === 'darwin'
        ? `Install kubectl with the rest of the cluster tools:\n${YAAC_CLUSTER_INSTALL}`
        : 'Install kubectl: https://kubernetes.io/docs/tasks/tools/',
    })
    return { ok: false, results }
  }

  try {
    await ensureKubernetes()
    add({ name: 'cluster', status: 'pass', detail: 'API server reachable' })
  } catch (err) {
    add({
      name: 'cluster', status: 'fail', detail: await unreachableDetail(err), fix: KIND_SETUP_FIX,
    })
    return { ok: false, results }
  }

  // Node inventory, read once for every gate that needs it. Whether a
  // workspace fits on a node depends on the tolerations declared on the
  // gvisor RuntimeClass, which admission merges into every pod naming it.
  // No class (a fresh install) means no tolerations.
  const gvisorScheduling = await gvisorRuntimeClass()
  let rawNodes: RawNodeItem[] | null = null
  try {
    rawNodes = await listObjects<RawNodeItem>('v1', 'Node')
  } catch (err) {
    add({ name: 'nodes', status: 'warn', detail: `could not list nodes (${k8sErrorSummary(err)})` })
    for (const name of ['architecture', 'node-os']) {
      add({ name, status: 'warn', detail: `could not read the nodes (${k8sErrorSummary(err)})` })
    }
  }
  const nodes = (rawNodes ?? []).map((n) => clusterNode(n, gvisorScheduling.tolerations))
  // Every Ready node infrastructure-only is an autoscaled workspace pool at
  // zero: nowhere to run a sandboxed pod, so those gates skip rather than
  // fail, and run once a workspace node is up. A pool node that is up but
  // unusable (cordoned, an untolerated taint) is not idle and still fails.
  const readyNodes = nodes.filter((n) => n.ready)
  const idlePool = readyNodes.length > 0 && readyNodes.every((n) => n.infraOnly)
  if (rawNodes) {
    add(nodeInventoryResult(nodes, idlePool))
    // Re-run the `--byo` platform gates, in case a node was added since.
    for (const r of nodePlatformChecks(rawNodes)) add(r)
  }

  try {
    await execFileAsync('podman', ['--version'])
    add({ name: 'podman', status: 'pass', detail: 'installed (image build engine)' })
  } catch {
    add({
      name: 'podman', status: 'fail', detail: 'not found on PATH',
      fix: 'Install podman — yaac builds session images with it.'
        + (process.platform === 'darwin' ? ` It comes with:\n${YAAC_CLUSTER_INSTALL}` : ''),
    })
  }

  // From the host this goes through a kubectl port-forward, so a failure
  // means a missing Deployment or an apiserver that will not forward.
  if (await registryReachable()) {
    add(await registryGateResult())
  } else {
    add({
      name: 'registry', status: 'fail',
      detail: `the in-cluster registry ${registryHost()} is not answering`,
      fix: 'The registry is an in-cluster Deployment installed by `yaac '
        + 'cluster install` and re-ensured by the yaac server on start. '
        + 'Re-apply it with:\n  yaac cluster install\n'
        + `Inspect it with \`kubectl -n ${REGISTRY_NAMESPACE} get deploy,pods -l app=yaac-main-registry\`.`,
    })
  }

  try {
    await ensureNamespace()
    add({ name: 'namespace', status: 'pass', detail: `"${k8sNamespace()}" present` })
  } catch (err) {
    add({
      name: 'namespace', status: 'fail',
      detail: `cannot create namespace "${k8sNamespace()}" (${k8sErrorSummary(err)})`,
      fix: 'Check your kubeconfig context has admin rights on the cluster.',
    })
  }

  add(await runStorageCheck())
  add(await runPriorityClassCheck())
  const token = await tokenEndpointCheck()
  if (token !== null) add(token)

  const PROBE_GATES = [
    'node-fixups', 'gvisor', 'gvisor-installer', 'probe', 'mountd', 'egress', 'npm-cache', 'sites',
    'datapath', 'per-node', 'storage-semantics', 'vap', 'node-local-fs',
  ] as const
  const skipFrom = (from: (typeof PROBE_GATES)[number], detail: string): void => {
    for (const name of PROBE_GATES.slice(PROBE_GATES.indexOf(from))) {
      add({ name, status: 'skip', detail })
    }
  }
  if (results.some((r) => r.status === 'fail')) {
    skipFrom('node-fixups', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  const idleSkip = (name: string): CheckResult => ({
    name, status: 'skip', detail: 'skipped — no Ready node takes workspaces to run a sandboxed pod on',
  })
  add(await runNodeFixupsCheck(nodes.map((n) => n.name)))
  add(idlePool ? idleSkip('gvisor') : await runGvisorRuntimeCheck(rawNodes))
  add(await runInstallerReadinessCheck())

  // The probes run on the gvisor RuntimeClass; without it they would sit
  // Pending until timeout.
  if (results.some((r) => r.status === 'fail')) {
    skipFrom('probe', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  let sandboxResults: CheckResult[]
  if (idlePool) {
    sandboxResults = [
      'probe', 'mountd', 'egress', 'npm-cache', 'sites', 'per-node', 'storage-semantics',
    ].map(idleSkip)
  } else {
    // Probe pods run as the workspace uid/gid recorded on the server
    // Deployment, not this machine's. If it cannot be read, fail here rather
    // than let a wrong-uid probe fail with a misleading message.
    let identity: InstallIdentity
    try {
      identity = await deployedInstallIdentity((await readInstallRecord())?.byo === true)
    } catch (err) {
      add({
        name: 'probe', status: 'fail',
        detail: `could not read the install identity off the ${SERVER_APP_NAME} Deployment: `
          + `${k8sErrorSummary(err)}`,
      })
      skipFrom('egress', 'skipped — fix the failures above first')
      return { ok: false, results }
    }
    // The pod probes run concurrently: each starts its own gVisor sandbox,
    // which is slow, and they share no pods or files.
    sandboxResults = await Promise.all([
      runEndToEndProbe(identity),
      ensureProbeImage().then((image) => runMountdProbe(image, identity)),
      runNetworkPolicyProbe(),
      runNpmCacheProbe(),
      runSitesProbe(),
      runPerNodeProbe(nodes, gvisorScheduling, identity),
      runStorageSemanticsProbe(identity),
    ])
  }
  const [
    probeResult, mountdResult, egressResult, npmCacheResult, sitesResult, perNodeResult, semanticsResult,
  ] = sandboxResults
  add(probeResult)
  add(mountdResult)
  add(egressResult)
  add(npmCacheResult)
  add(sitesResult)

  add(await runDatapathCheck())
  add(perNodeResult)
  add(semanticsResult)
  add(await runVapAvailabilityCheck())
  add(await runNodeLocalFsCheck())

  return { ok: !results.some((r) => r.status === 'fail'), results }
}

/**
 * Whether each byo node's node-local root, where workspace trees live, has
 * a filesystem of its own (docs/node-local-workspaces.md "A full
 * node"). On kubelet's filesystem the full-node guard is a race a fast
 * writer can win, and kubelet's own eviction gives no grace period, so a
 * node sharing it is a warning. kind's trees are on the host's disk either
 * way, so it is skipped there. One pod per node compares the root's
 * device with that of its `/etc/hosts`, a file kubelet keeps in its own
 * folder, so nothing of kubelet's is mounted.
 */
async function runNodeLocalFsCheck(): Promise<CheckResult> {
  const name = 'node-local-fs'
  if ((await readInstallRecord())?.byo !== true) {
    return { name, status: 'skip', detail: 'skipped — kind keeps workspace trees on the host disk' }
  }
  try {
    const image = await ensureUtilityImage()
    const runs = await runOnEachNode({
      name: 'yaac-nlfs-check',
      labels: { app: 'yaac-node-local-fs-check', [LABEL_INSTALL_ID]: installId() },
      timeoutMs: 120_000,
      pod: () => ({
        image,
        command: ['sh', '-c', '[ "$(stat -c %d /node)" = "$(stat -c %d /etc/hosts)" ] && echo shared || echo own'],
        container: {
          securityContext: { runAsUser: 0 },
          volumeMounts: [{ name: 'node', mountPath: '/node', readOnly: true }],
        },
        spec: {
          volumes: [{ name: 'node', hostPath: { path: nodeLocalNodePath(), type: 'DirectoryOrCreate' } }],
        },
      }),
    })
    const shared = runs.filter((r) => r.phase === 'Succeeded' && r.logs.trim().endsWith('shared')).map((r) => r.node)
    const unread = runs.filter((r) => r.phase !== 'Succeeded').map((r) => r.node)
    if (shared.length === 0 && unread.length === 0) {
      return { name, status: 'pass', detail: `workspace trees have a filesystem of their own on all ${String(runs.length)} node(s)` }
    }
    return {
      name,
      status: 'warn',
      detail: [
        shared.length > 0 ? `workspace trees share kubelet's filesystem on ${shared.join(', ')}` : '',
        unread.length > 0 ? `could not tell on ${unread.join(', ')}` : '',
      ].filter(Boolean).join('; '),
      fix: 'Mount a filesystem of its own at /var/lib/yaac/node on each node '
        + '(as infra/hetzner-k3s does), so a full workspace tree cannot fill the disk kubelet and containerd use.',
    }
  } catch (err) {
    return { name, status: 'warn', detail: `could not check the node-local filesystem (${k8sErrorSummary(err)})` }
  }
}

/**
 * What the readiness gates need to know about one node. `schedulable` means
 * a workspace pod could land here: the node is not cordoned, not labelled
 * infrastructure-only (`infraOnly`, see WORKSPACE_POOL_KEY), and every taint
 * is tolerated by the gvisor RuntimeClass. `excludedBecause` says why not,
 * so reports can name skipped nodes.
 */
interface ClusterNode {
  name: string
  ready: boolean
  infraOnly: boolean
  schedulable: boolean
  excludedBecause: string
  labels: Record<string, string>
}

interface RawNodeItem extends PlatformNode {
  spec?: { unschedulable?: boolean; taints?: NodeTaint[] }
  status?: PlatformNode['status'] & {
    conditions?: Array<{ type?: string; status?: string }>
  }
}

/**
 * Why a workspace cannot land on this node, or '' when one can. Cordoning
 * is reported apart from taints because the fix differs.
 */
function workspaceExclusion(node: RawNodeItem, tolerations: PodToleration[]): string {
  if (node.spec?.unschedulable === true) return 'cordoned'
  if (node.metadata?.labels?.[WORKSPACE_POOL_KEY] === 'false') return `infrastructure only (${WORKSPACE_POOL_KEY}=false)`
  const blocking = untoleratedTaints(node.spec?.taints, tolerations)
  if (blocking.length === 0) return ''
  return `untolerated taint ${blocking.map(formatTaint).join(', ')}`
}

function clusterNode(n: RawNodeItem, tolerations: PodToleration[]): ClusterNode {
  const excludedBecause = workspaceExclusion(n, tolerations)
  return {
    name: n.metadata?.name ?? '<unnamed>',
    ready: (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    infraOnly: n.metadata?.labels?.[WORKSPACE_POOL_KEY] === 'false',
    schedulable: excludedBecause === '',
    excludedBecause,
    labels: n.metadata?.labels ?? {},
  }
}

/** `name (why)` for every node a workspace cannot land on, truncated. */
function excludedList(nodes: ClusterNode[]): string {
  return nodeList(nodes
    .filter((n) => !n.schedulable)
    .map((n) => `${n.name} (${n.excludedBecause})`))
}

const SESSION_SCHEDULING_FIX =
  'A session pod tolerates exactly what the gvisor RuntimeClass declares in '
  + '`scheduling.tolerations` (the admission controller merges it into every '
  + 'pod naming the class), so a node whose taints it does not match leaves '
  + 'sessions Pending forever. Uncordon a node (`kubectl uncordon <node>`), '
  + 'wait out a transient pressure taint, or — for a deliberately tainted '
  + `sessions pool — taint it with the ${WORKSPACE_POOL_KEY} key, which the `
  + 'RuntimeClass already tolerates, rather than removing the taint that '
  + 'keeps other workloads off the pool.'

/**
 * The node inventory result. Warns on NotReady nodes or when no node can
 * take a workspace; node count alone is fine (`--nodes N` is supported).
 * When `idlePool` (every Ready node infrastructure-only), the workspace
 * pool is idle rather than misconfigured, and the sandboxed-pod gates skip.
 */
function nodeInventoryResult(nodes: ClusterNode[], idlePool: boolean): CheckResult {
  if (nodes.length === 0) {
    return { name: 'nodes', status: 'warn', detail: 'the cluster reports no nodes' }
  }
  const notReady = nodes.filter((n) => !n.ready).map((n) => n.name)
  if (notReady.length > 0) {
    return {
      name: 'nodes', status: 'warn',
      detail: `${nodes.length} node(s), NotReady: ${notReady.join(', ')}`,
      fix: 'A NotReady node runs nothing. Check the CNI on it '
        + '(`kubectl get pods -A -o wide -l k8s-app=calico-node`).',
    }
  }
  const eligible = nodes.filter((n) => n.schedulable)
  if (idlePool) {
    return {
      name: 'nodes', status: 'warn',
      detail: `${nodes.length} node(s), none taking workspaces: ${excludedList(nodes)}; `
        + 'the gates that run a sandboxed pod are skipped',
      fix: 'An autoscaled workspace pool adds a node when a workspace starts; re-run `yaac cluster '
        + 'check` while one is up to cover those gates. A cluster with no workspace nodes needs the '
        + `${WORKSPACE_POOL_KEY}=false label off one of its nodes.`,
    }
  }
  if (eligible.length === 0) {
    return {
      name: 'nodes', status: 'warn',
      detail: `${nodes.length} node(s), none able to schedule a session: ${excludedList(nodes)}`,
      fix: SESSION_SCHEDULING_FIX,
    }
  }
  if (nodes.length === 1) {
    return { name: 'nodes', status: 'pass', detail: 'single-node cluster' }
  }
  // Name excluded nodes even on a pass.
  return {
    name: 'nodes', status: 'pass',
    detail: `${nodes.length} nodes, ${eligible.length} able to schedule sessions`
      + (eligible.length < nodes.length ? `; skipping ${excludedList(nodes)}` : ''),
  }
}

const NODE_FIXUPS_FIX =
  'The pids limit is a setting of the kind node CONTAINER (podman state, not '
  + 'node state), which a cluster recreate drops. Re-apply it with: yaac cluster install'

/**
 * Warn if the kind-only node fixup `yaac cluster install` applies through
 * podman, the node container's pids limit, is missing. Its absence shows up
 * late, as workspaces dying under subagent fan-out. Skips byo installs and
 * nodes that are not podman containers.
 */
async function runNodeFixupsCheck(nodes: string[]): Promise<CheckResult> {
  // Checked explicitly: a byo install on kind also has podman node
  // containers, but their settings are not yaac's to manage.
  if ((await readInstallRecord())?.byo) {
    return {
      name: 'node-fixups', status: 'skip',
      detail: 'a byo install — the pids limit is the node pool\'s, not yaac\'s',
    }
  }
  try {
    if (nodes.length === 0) {
      return { name: 'node-fixups', status: 'warn', detail: 'no nodes found — fixups unverified' }
    }
    const short: string[] = []
    for (const node of nodes) {
      let pidsRaw: string
      try {
        pidsRaw = (await execFileAsync('podman', [
          'inspect', '--format', '{{.HostConfig.PidsLimit}}', node,
        ])).stdout
      } catch {
        return {
          name: 'node-fixups', status: 'skip',
          detail: `node "${node}" is not a podman container — kind node fixups not applicable`,
        }
      }
      const pids = Number(pidsRaw.trim())
      if (Number.isFinite(pids) && pids > 0 && pids < NODE_PIDS_LIMIT) short.push(node)
    }
    if (short.length > 0) {
      return {
        name: 'node-fixups', status: 'warn',
        detail: `pids limit below ${NODE_PIDS_LIMIT} (subagent fan-out) on ${short.join(', ')}`,
        fix: NODE_FIXUPS_FIX,
      }
    }
    return {
      name: 'node-fixups', status: 'pass',
      detail: 'pids limit in place',
    }
  } catch (err) {
    return {
      name: 'node-fixups', status: 'warn',
      detail: `could not verify node fixups (${k8sErrorSummary(err)})`,
      fix: NODE_FIXUPS_FIX,
    }
  }
}

const STORAGE_FIX =
  'The storage claims are applied by `yaac cluster install`: on kind, '
  + 'static hostPath volumes into the data dir\'s `global/` and `server-local/` '
  + 'folders; on a byo install, volumes provisioned from the named classes, '
  + 'pinned `Retain`, labelled, and (the RWX one) mounted with `actimeo=1`, plus '
  + 'a copy of the RWX one that checkouts are mounted through. '
  + 'Re-run it; it converges each of these in place.'

interface RawPvcRead {
  spec?: { volumeName?: string }
  status?: { phase?: string }
}
interface RawPvRead {
  metadata?: { labels?: Record<string, string> }
  spec?: {
    persistentVolumeReclaimPolicy?: string
    hostPath?: { path?: string }
    csi?: { driver?: string; volumeHandle?: string; volumeAttributes?: Record<string, string> }
    storageClassName?: string
    mountOptions?: string[]
  }
}

/**
 * The storage gate (fail-level; the server pod and the probes mount the
 * global claim). Every claim must be Bound with a `Retain` volume, so
 * deleting a claim or namespace never deletes data. The checkouts volume
 * must be the global tier's directory again (`checkoutsVolumeProblems`).
 * The other two are judged by volume class:
 *
 * - No class (kind's static volumes): a hostPath into this data dir's own
 *   tier folder. (Checked by class, not source, because local-path also
 *   provisions hostPath volumes.) Such an install also has `yaac-volumes`,
 *   checked the same way (docs/workspace-volumes.md).
 * - Provisioned (byo): carries this install's labels, which re-install
 *   uses to find it. The global volume must also be NFS-family and mounted
 *   with `actimeo<=1`, the cross-pod visibility delay the shared tier
 *   assumes.
 */
async function runStorageCheck(): Promise<CheckResult> {
  const ns = k8sNamespace()
  const expectedHostPath: Record<string, string> = {
    [GLOBAL_CLAIM_NAME]: globalRoot(),
    [SERVER_LOCAL_CLAIM_NAME]: serverLocalRoot(),
    [VOLUMES_CLAIM_NAME]: volumesRoot(),
  }
  try {
    const problems: string[] = []
    const bound: string[] = []
    const ours = (name: string, labels: Record<string, string>): boolean =>
      labels[LABEL_INSTALL_ID] === installId() && labels[LABEL_CLAIM] === name
    const claims = [GLOBAL_CLAIM_NAME, SERVER_LOCAL_CLAIM_NAME]
    for (const name of claims) {
      const pvc = await readObject<RawPvcRead>({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', name, namespace: ns })
      if (!pvc) {
        problems.push(`${name}: no such claim in "${ns}"`)
        continue
      }
      const phase = pvc.status?.phase ?? 'Pending'
      if (phase !== 'Bound') {
        problems.push(`${name}: ${phase}`)
        continue
      }
      const volumeName = pvc.spec?.volumeName ?? ''
      const pv = await readPv(volumeName)
      const reclaim = pv?.spec?.persistentVolumeReclaimPolicy
      if (reclaim !== 'Retain') {
        problems.push(`${name}: volume ${volumeName} reclaims by ${reclaim ?? 'an unknown policy'}, not Retain`)
      }
      if (!pv?.spec?.storageClassName) {
        // A static global volume means kind, which has the volumes claim too.
        if (name === GLOBAL_CLAIM_NAME) claims.push(VOLUMES_CLAIM_NAME)
        const hostPath = pv?.spec?.hostPath?.path
        if (hostPath !== expectedHostPath[name]) {
          problems.push(`${name}: volume ${volumeName} is ${hostPath ?? 'not a hostPath volume'}, `
            + `not ${expectedHostPath[name]}`)
        }
        bound.push(`${name} → ${volumeName} (${hostPath ?? '?'})`)
        continue
      }
      if (!ours(name, pv.metadata?.labels ?? {})) {
        problems.push(`${name}: volume ${volumeName} does not carry this install's labels, so a `
          + 're-install could not find it again')
      }
      if (name === GLOBAL_CLAIM_NAME) problems.push(...await sharedVolumeProblems(volumeName, pv))
      bound.push(`${name} → ${volumeName} (${pv.spec.storageClassName})`)
    }
    if (problems.length > 0) {
      return { name: 'storage', status: 'fail', detail: problems.join('; '), fix: STORAGE_FIX }
    }
    return { name: 'storage', status: 'pass', detail: `${bound.join('; ')}, all Bound and Retain` }
  } catch (err) {
    return {
      name: 'storage', status: 'fail',
      detail: `could not read the storage claims (${k8sErrorSummary(err)})`,
      fix: STORAGE_FIX,
    }
  }
}

function readPv(name: string): Promise<RawPvRead | null> {
  return readObject<RawPvRead>({ apiVersion: 'v1', kind: 'PersistentVolume', name })
}

/** What a provisioned global volume must be, beyond Bound and Retain. */
async function sharedVolumeProblems(volumeName: string, pv: RawPvRead | null): Promise<string[]> {
  const problems: string[] = []
  const className = pv?.spec?.storageClassName ?? ''
  const sc = className
    ? await readObject<{ provisioner?: string; parameters?: Record<string, string> }>({
      apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', name: className,
    })
    : null
  const nfs = sc
    ? isNfsFamily(sc.provisioner ?? '', sc.parameters)
    : isNfsFamily(pv?.spec?.csi?.driver ?? '', pv?.spec?.csi?.volumeAttributes)
  if (!nfs) {
    problems.push(`${GLOBAL_CLAIM_NAME}: ${sc ? `class ${className} (${sc.provisioner ?? '?'})` : `volume ${volumeName}`} `
      + 'is not NFS-family — the only RWX storage a byo install is measured against')
  }
  const actimeo = (pv?.spec?.mountOptions ?? [])
    .map((o) => /^actimeo=(\d+)$/.exec(o)?.[1]).find((v) => v !== undefined)
  if (actimeo === undefined || Number(actimeo) > 1) {
    problems.push(`${GLOBAL_CLAIM_NAME}: volume ${volumeName} is mounted with `
      + `${actimeo === undefined ? 'no actimeo' : `actimeo=${actimeo}`}, not actimeo<=1 — another `
      + 'pod\'s writes could stay invisible for up to a minute')
  }
  return problems
}

/**
 * The two `--byo` node gates (byo-gates.ts), fail-level on every backend:
 * nodes must match this machine's architecture (images are built here),
 * and run stock containerd on a mutable OS for the gVisor installer.
 */
function nodePlatformChecks(nodes: PlatformNode[]): CheckResult[] {
  const hostArch = hostNodeArchitecture()
  const arch = nodeArchitectureProblems(nodes, hostArch)
  const os = nodeOsProblems(nodes)
  return [
    arch.length > 0
      ? {
        name: 'architecture', status: 'fail', detail: arch.join(' '),
        fix: 'Replace or remove the nodes of the other architecture, or run yaac from a machine of theirs.',
      }
      : { name: 'architecture', status: 'pass', detail: `every node is ${hostArch}, as this machine is` },
    os.length > 0
      ? {
        name: 'node-os', status: 'fail', detail: os.join(' '),
        fix: 'Sessions need nodes running stock containerd on a mutable OS image.',
      }
      : { name: 'node-os', status: 'pass', detail: 'containerd on a mutable OS on every node' },
  ]
}

function installerFix(): string {
  return 'The gVisor installer DaemonSet installs runsc and applies the node tuning on '
    + 'every node it lands on, and marks its pod Ready only after a pass, so a node that '
    + 'just restarted reads as not ready until its first pass lands. If it '
    + `stays this way, read the installer's log: kubectl -n ${k8sNamespace()} logs `
    + `-l app=${GVISOR_INSTALLER_APP_NAME}\nRe-apply the DaemonSet with: yaac cluster install`
}

/**
 * Warn-level check that the current gVisor installer revision is Ready on
 * every node it targets. Its readiness marker is written only after a pass
 * has installed runsc and written the node tuning (node-tuning.ts).
 * A `DefaultTasksMax` that another drop-in overrides does not hold the
 * marker back; the installer only logs it. Names the nodes not Ready.
 */
async function runInstallerReadinessCheck(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const ds = await readObject<{
      status?: { desiredNumberScheduled?: number; numberReady?: number; updatedNumberScheduled?: number }
    }>({ apiVersion: 'apps/v1', kind: 'DaemonSet', name: GVISOR_INSTALLER_APP_NAME, namespace: ns })
    if (!ds) {
      return {
        name: 'gvisor-installer', status: 'warn',
        detail: `the ${GVISOR_INSTALLER_APP_NAME} DaemonSet is not deployed`, fix: installerFix(),
      }
    }
    const desired = ds.status?.desiredNumberScheduled ?? 0
    const ready = ds.status?.numberReady ?? 0
    const updated = ds.status?.updatedNumberScheduled ?? 0
    if (desired > 0 && ready === desired && updated === desired) {
      return {
        name: 'gvisor-installer', status: 'pass',
        detail: `Ready on all ${desired} node(s): runsc installed and node tuning written`,
      }
    }
    const pods = await listObjects<
      { spec?: { nodeName?: string }; status?: { containerStatuses?: Array<{ ready?: boolean }> } }
    >('v1', 'Pod', { namespace: ns, labelSelector: `app=${GVISOR_INSTALLER_APP_NAME}` })
    const notReady = pods
      .filter((p) => !p.status?.containerStatuses?.[0]?.ready)
      .map((p) => p.spec?.nodeName ?? '<unscheduled>')
    return {
      name: 'gvisor-installer', status: 'warn',
      detail: `Ready on ${ready} of ${desired} node(s), current revision on ${updated}`
        + (notReady.length > 0 ? `; not ready on ${nodeList(notReady)}` : ''),
      fix: installerFix(),
    }
  } catch (err) {
    return {
      name: 'gvisor-installer', status: 'warn',
      detail: `could not read the installer DaemonSet (${k8sErrorSummary(err)})`, fix: installerFix(),
    }
  }
}

/**
 * Once the registry answers, check its gate: an anonymous write must be
 * refused on the node port, or any builder pod could overwrite trusted
 * images, and an anonymous read of a project repo must be refused on the
 * pod port, or one project's build could read another's images. The probe
 * upload is only started, never finished; an open registry purges the
 * empty session itself.
 */
async function registryGateResult(): Promise<CheckResult> {
  const answer = async (url: string, method: string): Promise<number | null> => {
    try {
      return (await fetch(url, { method, signal: AbortSignal.timeout(5_000) })).status
    } catch {
      return null
    }
  }
  const write = await answer(`http://${await registryEndpoint()}/v2/yaac-cluster-probe/blobs/uploads/`, 'POST')
  const podEndpoint = await registryPodEndpoint().catch(() => null)
  const read = podEndpoint === null
    ? null
    : await answer(`http://${podEndpoint}/v2/yaac-proj-00000000-0000-0000-0000-000000000000/tags/list`, 'GET')
  if (write === 401 && read === 401) {
    return {
      name: 'registry', status: 'pass',
      detail: `serving as ${registryHost()}; writes, and pods' reads of project images, need a grant`,
    }
  }
  if ((write !== null && write >= 200 && write < 300) || (read !== null && read !== 401)) {
    return {
      name: 'registry', status: 'fail',
      detail: `the in-cluster registry ${registryHost()} `
        + (write !== null && write < 300 ? 'accepts anonymous writes' : `answers HTTP ${String(read)} to an anonymous read of a project repo on its pod port`)
        + ' — its gate is missing or out of date',
      fix: 'Re-apply the gate with:\n  yaac cluster install',
    }
  }
  return {
    name: 'registry', status: 'warn',
    detail: `serving as ${registryHost()}, but its gate could not be verified `
      + `(${write === null ? 'no answer' : `HTTP ${String(write)}`} to an anonymous upload, `
      + `${read === null ? 'no answer' : `HTTP ${String(read)}`} to an anonymous project read on the pod port)`,
  }
}

/** Push the busybox probe image to the registry; returns its cluster ref. */
async function ensureProbeImage(): Promise<string> {
  try {
    await execFileAsync('podman', ['image', 'inspect', PROBE_LOCAL_TAG])
  } catch {
    await execFileAsync('podman', ['pull', PROBE_SOURCE_IMAGE], { timeout: 120_000 })
    await execFileAsync('podman', ['tag', PROBE_SOURCE_IMAGE, PROBE_LOCAL_TAG])
  }
  return pushImageToRegistry(PROBE_LOCAL_TAG)
}

/**
 * Run one probe pod to completion in the install namespace: a single
 * container named `probe`, with no service-account token or service links.
 */
function runProbePod(name: string, opts: {
  timeoutMs: number
  labels?: Record<string, string>
  /** Pod spec fields beyond the boilerplate (runtime class, volumes, ...). */
  spec?: Record<string, unknown>
  container: Record<string, unknown>
}): ReturnType<typeof runPodToCompletion> {
  return runPodToCompletion({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: k8sNamespace(), ...(opts.labels ? { labels: opts.labels } : {}) },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...opts.spec,
      containers: [{ name: 'probe', ...opts.container }],
    },
  }, { timeoutMs: opts.timeoutMs })
}

/** A workspace pod's pod-level securityContext, at the install identity. */
function workspaceSecurityContext(identity: InstallIdentity): Record<string, unknown> {
  return { seccompProfile: { type: 'RuntimeDefault' }, ...installSecurityContext(identity) }
}

/** The global claim, as the volume a probe pod mounts at `/probe`. */
const GLOBAL_CLAIM_VOLUME = {
  volumeMounts: [{ name: 'probe', mountPath: '/probe' }],
  volumes: [{ name: 'probe', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }],
}

const GVISOR_PROBE_POD_NAME = 'yaac-cluster-check-gvisor'

/** A function because the namespace must not be read at import time. */
function gvisorFix(): string {
  return 'Install the gVisor runtime with: yaac cluster install\n'
    + '(applies the yaac-gvisor-install DaemonSet, which drops a pinned runsc, '
    + 'its shim and its sidecars on every node, registers the runsc handler in '
    + 'its containerd and labels it, plus the gvisor RuntimeClass that '
    + 'schedules on that label)\n'
    + `Inspect it with: kubectl -n ${k8sNamespace()} logs -l app=yaac-gvisor-install`
}

const PRIORITY_CLASS_FIX = 'Install the yaac PriorityClasses with: yaac cluster install'

/**
 * The PriorityClass gate. The apiserver rejects a pod naming a missing
 * class, so a workspace Job would apply and then hang with no pod. Values
 * that differ from this yaac's only warn: pods still schedule, just ranked
 * wrong.
 */
async function runPriorityClassCheck(): Promise<CheckResult> {
  const expected = buildPriorityClassManifests() as Array<{
    metadata: { name: string }
    value: number
    preemptionPolicy?: string
  }>
  try {
    const live = new Map((await listObjects<
      { metadata?: { name?: string }; value?: number; preemptionPolicy?: string }
    >('scheduling.k8s.io/v1', 'PriorityClass')).map((c) => [c.metadata?.name ?? '', c]))

    const missing = expected.filter((e) => !live.has(e.metadata.name))
    if (missing.length > 0) {
      return {
        name: 'priority-classes', status: 'fail',
        detail: `missing PriorityClass(es): ${missing.map((e) => e.metadata.name).join(', ')}`,
        fix: PRIORITY_CLASS_FIX,
      }
    }
    const drifted = expected.filter((e) => {
      const c = live.get(e.metadata.name)
      // Kubernetes materializes the omitted policy as PreemptLowerPriority.
      const wantPolicy = e.preemptionPolicy ?? 'PreemptLowerPriority'
      return c?.value !== e.value || (c?.preemptionPolicy ?? 'PreemptLowerPriority') !== wantPolicy
    })
    if (drifted.length > 0) {
      return {
        name: 'priority-classes', status: 'warn',
        detail: `PriorityClass(es) differ from this yaac's: ${drifted.map((e) => e.metadata.name).join(', ')}`,
        fix: PRIORITY_CLASS_FIX,
      }
    }
    return {
      name: 'priority-classes', status: 'pass',
      detail: `${expected.map((e) => e.metadata.name).join(', ')} present`,
    }
  } catch (err) {
    return {
      name: 'priority-classes', status: 'fail',
      detail: `could not read PriorityClasses (${k8sErrorSummary(err)})`,
      fix: PRIORITY_CLASS_FIX,
    }
  }
}

/**
 * The gVisor gate. Workspace pods rely on gVisor for isolation, so a
 * missing RuntimeClass, or a handler that silently runs runc, is unsafe.
 * Checks that:
 *
 * 1. the RuntimeClass exists;
 * 2. at least one node has the installer's label (otherwise the probe pod
 *    would just sit Pending with a misleading error);
 * 3. a pod on the gvisor class is really sandboxed: gVisor's dmesg shows
 *    its own boot messages, while runc shows the node kernel's.
 */
async function runGvisorRuntimeCheck(nodes: RawNodeItem[] | null): Promise<CheckResult> {
  try {
    const present = new Set((await listObjects('node.k8s.io/v1', 'RuntimeClass'))
      .map((rc) => rc.metadata?.name))
    if (!present.has(RUNTIME_CLASS_GVISOR)) {
      return {
        name: 'gvisor', status: 'fail',
        detail: `missing RuntimeClass: ${RUNTIME_CLASS_GVISOR}`,
        fix: gvisorFix(),
      }
    }

    // An unreadable node list is left to the sandbox probe below.
    if (nodes && !nodes.some((n) => n.metadata?.labels?.[GVISOR_NODE_LABEL] === 'true')) {
      return {
        name: 'gvisor', status: 'fail',
        detail: `no node carries the ${GVISOR_NODE_LABEL} label — the installer `
          + 'DaemonSet has not converged on any node (a cluster set up by an older '
          + 'yaac reads this way until it is applied)',
        fix: gvisorFix(),
      }
    }

    const { phase, logs } = await runProbePod(GVISOR_PROBE_POD_NAME, {
      timeoutMs: 90_000,
      spec: { runtimeClassName: RUNTIME_CLASS_GVISOR },
      container: {
        image: await ensureProbeImage(),
        command: [
          'sh', '-c',
          'dmesg 2>/dev/null | grep -qi gvisor && echo GVISOR_SANDBOXED || echo GVISOR_NOT_SANDBOXED',
        ],
      },
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'gvisor', status: 'fail',
        detail: `gvisor probe pod ended in phase ${phase} — runsc cannot run pods on this node`,
        fix: gvisorFix(),
      }
    }
    if (!logs.includes('GVISOR_SANDBOXED')) {
      return {
        name: 'gvisor', status: 'fail',
        detail: 'a pod on the gvisor RuntimeClass is not sentry-sandboxed — the handler is not actually runsc',
        fix: gvisorFix(),
      }
    }
    return {
      name: 'gvisor', status: 'pass',
      detail: 'RuntimeClass present; gvisor pods run inside the sentry',
    }
  } catch (err) {
    return {
      name: 'gvisor', status: 'fail',
      detail: `gvisor probe errored (${k8sErrorSummary(err)})`,
      fix: gvisorFix(),
    }
  }
}

/**
 * Shell function printing epoch milliseconds. busybox `date` has no `%N`;
 * `adjtimex` in read-only mode needs no capability.
 */
const PEER_MS_FN =
  'ms() { adjtimex | awk \'/tv_sec/{s=$2}/tv_usec/{u=$2}END{print s*1000+int(u/1000)}\'; }'

/**
 * Run a peer pod that plays the server's role for a probe: runc, at the
 * install identity, with `yaac-global` mounted whole. It exchanges nonces with the
 * probe pod through the claim.
 *
 * `pair` labels it and prefers a different node from any pod with the
 * same label, so on a multi-node cluster the exchange crosses nodes. Its
 * node name is in the environment for reporting.
 */
function runPeerPod(opts: {
  name: string
  imageRef: string
  identity: InstallIdentity
  pair: string
  script: string
  args: string[]
  timeoutMs: number
}): ReturnType<typeof runPodToCompletion> {
  return runProbePod(opts.name, {
    timeoutMs: opts.timeoutMs,
    labels: pairLabels(opts.pair),
    spec: {
      // Bounds a peer left Pending by an aborted check.
      activeDeadlineSeconds: 300,
      affinity: pairAntiAffinity(opts.pair),
      securityContext: workspaceSecurityContext(opts.identity),
      volumes: GLOBAL_CLAIM_VOLUME.volumes,
    },
    container: {
      image: opts.imageRef,
      securityContext: { allowPrivilegeEscalation: false },
      command: ['sh', '-c', opts.script, '--', ...opts.args],
      env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } }],
      volumeMounts: GLOBAL_CLAIM_VOLUME.volumeMounts,
    },
  })
}

const LABEL_CHECK_PAIR = 'yaac.cluster-check-pair'

function pairLabels(pair: string): Record<string, string> {
  return { [LABEL_CHECK_PAIR]: pair }
}

function pairAntiAffinity(pair: string): Record<string, unknown> {
  return {
    podAntiAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [{
        weight: 100,
        podAffinityTerm: {
          topologyKey: 'kubernetes.io/hostname',
          labelSelector: { matchLabels: pairLabels(pair) },
        },
      }],
    },
  }
}

/** A `KEY=value` line a probe or peer printed, or undefined. */
function reported(logs: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(logs)?.[1]
}

/** Best-effort delete of a probe's peer pod. */
async function releasePeer(name: string): Promise<void> {
  await deleteObject({ apiVersion: 'v1', kind: 'Pod', name, namespace: k8sNamespace() })
    .catch(() => { /* its own run deletes it anyway */ })
}

const PEER_POD_NAME = 'yaac-cluster-check-peer'
/** Each run's scratch dir is named by its nonce, so leftovers from an
 *  interrupted run are never mistaken for this one's. */
const PROBE_DIR_PREFIX = '.cluster-check-probe-'

/**
 * The peer's half of the end-to-end probe: clear old scratch, publish the
 * nonce atomically, wait for the probe's beacon, then write a second nonce
 * and time the probe's acknowledgement (the round trip through the claim).
 * Finally report whether the probe's write arrived, and clean up. All waits
 * are bounded; the check judges what it prints.
 */
const PEER_PROBE_SCRIPT = [
  PEER_MS_FN,
  `rm -rf /probe/${PROBE_DIR_PREFIX}*`,
  'd="/probe/$1"',
  'mkdir "$d" && printf %s "$2" > "$d/nonce.tmp" && mv "$d/nonce.tmp" "$d/nonce"',
  'echo "PEER_NODE=$NODE_NAME"',
  'i=0; while [ $i -lt 1600 ] && [ ! -f "$d/beacon" ]; do sleep 0.05; i=$((i+1)); done',
  'if [ -f "$d/beacon" ]; then',
  '  t0=$(ms); echo go > "$d/nonce2"',
  '  j=0; while [ $j -lt 6000 ] && [ ! -f "$d/ack" ]; do sleep 0.005; j=$((j+1)); done',
  '  if [ -f "$d/ack" ]; then echo "PEER_RTT_MS=$(( $(ms) - t0 ))"; fi',
  'fi',
  'echo "PEER_SAW_WRITE=$(cat "$d/write" 2>/dev/null)"',
  'rm -rf "$d"',
].join('\n')

/**
 * The probe's half: wait for the peer's nonce, print it and who it sees as
 * the owner of the peer's directory, write a marker for the peer, signal
 * the beacon, and acknowledge the second nonce. It runs at the workspace
 * uid under gVisor, like workspace setup.
 */
const PROBE_SCRIPT = [
  'd="/probe/$1"',
  'echo "PROBE_NODE=$NODE_NAME"',
  'i=0; while [ $i -lt 3000 ] && [ ! -f "$d/nonce" ]; do sleep 0.02; i=$((i+1)); done',
  'echo "PROBE_READ=$(cat "$d/nonce" 2>/dev/null)"',
  '[ -f "$d/nonce" ] || exit 0',
  'echo "PROBE_OWNER=$(stat -c %u "$d" 2>/dev/null)"',
  'echo ok > "$d/write" || exit 1',
  'echo > "$d/beacon"',
  'i=0; while [ $i -lt 1500 ] && [ ! -f "$d/nonce2" ]; do sleep 0.02; i=$((i+1)); done',
  'if [ -f "$d/nonce2" ]; then echo ok > "$d/ack"; fi',
].join('\n')

/**
 * End-to-end probe: a gVisor pod at the workspace uid pulls from the
 * registry, and exchanges reads and writes through the global claim with a
 * peer pod in the server's role. Each failure points at the part `yaac
 * cluster install` sets up: registry config, the claim, or the runtime.
 */
async function runEndToEndProbe(identity: InstallIdentity): Promise<CheckResult> {
  const nonce = crypto.randomUUID()
  const dir = `${PROBE_DIR_PREFIX}${nonce}`
  const { runAsUser } = installSecurityContext(identity)
  try {
    const imageRef = await ensureProbeImage()
    // The peer runs alongside and is deleted early if the probe fails.
    const probeRun = runProbePod(PROBE_POD_NAME, {
      timeoutMs: 90_000,
      labels: pairLabels('probe'),
      spec: {
        affinity: pairAntiAffinity('probe'),
        // Same runtime and uid as a workspace pod (buildPodJobManifest).
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        securityContext: workspaceSecurityContext(identity),
        volumes: GLOBAL_CLAIM_VOLUME.volumes,
      },
      container: {
        image: imageRef,
        command: ['sh', '-c', PROBE_SCRIPT, '--', dir],
        env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } }],
        volumeMounts: GLOBAL_CLAIM_VOLUME.volumeMounts,
      },
    })
    const peerRun = runPeerPod({
      name: PEER_POD_NAME, imageRef, identity, pair: 'probe',
      script: PEER_PROBE_SCRIPT, args: [dir, nonce], timeoutMs: 150_000,
    })
    void probeRun.then(async (r) => {
      if (r.phase !== 'Succeeded') await releasePeer(PEER_POD_NAME)
    }, () => { /* reported below */ })
    const [{ phase, logs }, peer] = await Promise.all([probeRun, peerRun])
    // The peer runs at the same uid, so its directory is the probe's own.
    const owner = reported(logs, 'PROBE_OWNER')
    if (owner !== undefined && owner !== String(runAsUser)) {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod sees the directory its peer made at uid ${runAsUser} as owned by `
          + `uid ${owner || 'unknown'}`,
        fix: 'The global claim does not report real file ownership to a gVisor pod, so no '
          + 'workspace can rely on a file\'s permissions. On macOS the podman machine did '
          + 'not start through yaac\'s krunkit wrapper; `yaac cluster install` restarts it '
          + 'through it (docs/cluster-setup.md "macOS: the podman machine").',
      }
    }
    if (phase !== 'Succeeded') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod ended in phase ${phase}`,
        fix: 'If the pod is stuck in ImagePullBackOff, the node cannot '
          + `pull from ${registryHost()} — its containerd hosts.toml for `
          + 'that host is missing or stale; re-apply it with `yaac cluster '
          + 'install`.\nIf it failed mounting /probe, the '
          + `${GLOBAL_CLAIM_NAME} claim or its volume is broken on the node — `
          + 'on kind the volume is a hostPath into the data dir, which the '
          + 'node needs the data dir extraMount to see; `yaac cluster install` '
          + 're-applies the claim.\n'
          + 'If it never got past Pending or failed with a runsc/'
          + 'RuntimeClass error, the gvisor runtime is broken — run '
          + '`yaac cluster install` (re-applies the runsc installer '
          + 'DaemonSet).\n'
          + 'If it failed writing the claim, uid '
          + `${runAsUser} cannot write the volume — see "The uid everything `
          + 'runs as" in docs/server-in-cluster.md.',
      }
    }
    const read = reported(logs, 'PROBE_READ') ?? ''
    if (read !== nonce) {
      return {
        name: 'probe', status: 'fail',
        detail: read === ''
          ? `probe pod never saw the nonce its peer wrote through the global claim (peer: ${
            peer.phase === 'Succeeded' ? 'ran' : `phase ${peer.phase}`})`
          : 'probe pod read stale data through the global claim',
        fix: `The two pods mount the same ${GLOBAL_CLAIM_NAME} claim, so a write one `
          + 'makes must be visible to the other. Check its volume (`kubectl get pv`) '
          + 'and, on kind, the extraMounts entry in your kind config.',
      }
    }
    // A workspace's uid must be able to write what the server reads.
    if (reported(peer.logs, 'PEER_SAW_WRITE') !== 'ok') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod's write (uid ${runAsUser}) through the global claim `
          + 'never reached its peer',
        fix: 'Session pods write the claim as the install uid; on a strict-virtiofs '
          + 'host that uid is a ceiling nothing in the cluster can raise, and on an '
          + 'NFS class the volume root must be the install uid\'s. See "The uid '
          + 'everything runs as" in docs/server-in-cluster.md.',
      }
    }
    const roundTrip = reported(peer.logs, 'PEER_RTT_MS')
    const probeNode = reported(logs, 'PROBE_NODE')
    const peerNode = reported(peer.logs, 'PEER_NODE')
    const where = probeNode && peerNode && probeNode !== peerNode ? 'cross-node ' : ''
    return {
      name: 'probe', status: 'pass',
      detail: `registry pull + global claim: read, write at uid ${runAsUser}`
        + (roundTrip === undefined ? '' : `, ${where}round trip ${roundTrip}ms`),
    }
  } catch (err) {
    return {
      name: 'probe', status: 'fail',
      detail: `probe errored (${k8sErrorSummary(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

const FSPROBE_CONFIGMAP_NAME = 'yaac-cluster-check-fsprobe'

/**
 * fsprobe checks whose failure is reported but does not fail the gate, each
 * with the reason. Waived by name on every backend, never per backend.
 */
const WAIVED_SEMANTICS: Record<string, string> = {
  // NFS before 4.2 (e.g. EFS, Azure Files) has no xattrs, and yaac writes
  // no user.* xattr.
  'user.* xattr': 'nothing yaac keeps on the shared tier uses xattrs',
}
const FSPROBE_POD_NAME = 'yaac-cluster-check-fsprobe'

const STORAGE_SEMANTICS_FIX =
  'A workspace relies on these from the global claim: creation ownership '
  + 'and O_EXCL for the lock and the staged files, atomic rename for every '
  + 'seed the server writes, hardlinks for the git object store, append for '
  + 'the ACP conversation records. On kind a failure is a virtiofs or gofer quirk; '
  + 'on a byo cluster it is the storage class, and the claim needs one that passes.'

/**
 * Check the POSIX semantics of the global claim's storage as a gVisor pod
 * at the workspace uid sees them, using k8s/probes/fsprobe.py (shipped in a
 * temporary ConfigMap, run in the utility image because it has python3).
 * Fail-level on every backend; a probe that cannot run also fails.
 */
async function runStorageSemanticsProbe(identity: InstallIdentity): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const script = await fs.readFile(path.join(PACKAGE_ROOT, 'k8s', 'probes', 'fsprobe.py'), 'utf8')
    await applyObject({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: FSPROBE_CONFIGMAP_NAME, namespace: ns },
      data: { 'fsprobe.py': script },
    })
    const { phase, logs } = await runProbePod(FSPROBE_POD_NAME, {
      timeoutMs: 120_000,
      spec: {
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        securityContext: workspaceSecurityContext(identity),
        volumes: [
          ...GLOBAL_CLAIM_VOLUME.volumes,
          { name: 'script', configMap: { name: FSPROBE_CONFIGMAP_NAME } },
        ],
      },
      container: {
        image: await ensureUtilityImage(),
        imagePullPolicy: 'IfNotPresent',
        // fsprobe leaves its scratch dir behind.
        command: ['sh', '-c', 'python3 /probes/fsprobe.py /probe; rc=$?; rm -rf /probe/fsprobe-*; exit $rc'],
        volumeMounts: [
          ...GLOBAL_CLAIM_VOLUME.volumeMounts,
          { name: 'script', mountPath: '/probes', readOnly: true },
        ],
      },
    })
    const failures = logs.split('\n')
      .filter((l) => l.startsWith('FAIL'))
      .map((l) => l.replace(/^FAIL\s+/, '').replace(/\s{2,}.*$/, '').trim())
    const failed = failures.filter((f) => !(f in WAIVED_SEMANTICS))
    const waived = failures.filter((f) => f in WAIVED_SEMANTICS)
      .map((f) => `; waived: ${f} (${WAIVED_SEMANTICS[f]})`).join('')
    const summary = /(\d+\/\d+ passed)/.exec(logs)?.[1]
    if (phase !== 'Succeeded' && failures.length === 0) {
      return {
        name: 'storage-semantics', status: 'fail',
        detail: `fsprobe pod ended in phase ${phase} (${logs.trim().slice(-80) || 'no output'})`,
        fix: STORAGE_SEMANTICS_FIX,
      }
    }
    if (failed.length > 0) {
      return {
        name: 'storage-semantics', status: 'fail',
        detail: `the global claim fails: ${failed.join(', ')}${summary ? ` (${summary})` : ''}`,
        fix: STORAGE_SEMANTICS_FIX,
      }
    }
    if (!summary) {
      return {
        name: 'storage-semantics', status: 'fail',
        detail: `fsprobe printed no summary (${logs.trim().slice(-80) || 'no output'})`,
        fix: STORAGE_SEMANTICS_FIX,
      }
    }
    return {
      name: 'storage-semantics', status: 'pass',
      detail: `POSIX semantics on the global claim under gvisor: ${summary}${waived}`,
    }
  } catch (err) {
    return {
      name: 'storage-semantics', status: 'fail',
      detail: `fsprobe errored (${k8sErrorSummary(err)})`,
      fix: STORAGE_SEMANTICS_FIX,
    }
  } finally {
    await deleteObject({ apiVersion: 'v1', kind: 'ConfigMap', name: FSPROBE_CONFIGMAP_NAME, namespace: ns })
      .catch(() => { /* best-effort */ })
  }
}

/**
 * The live gvisor RuntimeClass's `scheduling`, which admission merges into
 * every pod naming it, so it decides where sandboxed pods go:
 *
 *  - `nodeSelector`: the label the gVisor installer puts on nodes it has
 *    set up. A node outside it cannot host a workspace.
 *  - `tolerations`: what sandboxed pods tolerate, e.g. a tainted workspace
 *    pool. Empty locally, and when the class is missing.
 */
interface GvisorScheduling {
  nodeSelector: Record<string, string>
  tolerations: PodToleration[]
}

async function gvisorRuntimeClass(): Promise<GvisorScheduling> {
  const rc = await readObject<{
    scheduling?: { nodeSelector?: Record<string, string>; tolerations?: PodToleration[] }
  }>({ apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', name: RUNTIME_CLASS_GVISOR })
  return {
    nodeSelector: rc?.scheduling?.nodeSelector ?? {},
    tolerations: rc?.scheduling?.tolerations ?? [],
  }
}

/**
 * The pod's most recent Warning event, as `reason: message`. Events outlive
 * the pod, so this works after runPodToCompletion deletes it, and it covers
 * mount failures, which leave no containerStatuses. Selected by uid, since
 * an earlier run's pod of the same name leaves events behind too.
 */
async function podFailureEvent(uid: string | undefined): Promise<string> {
  if (!uid) return ''
  try {
    const items = await listObjects<{ type?: string; reason?: string; message?: string }>('v1', 'Event', {
      namespace: k8sNamespace(), fieldSelector: `involvedObject.uid=${uid}`,
    })
    const warning = items.filter((e) => e.type === 'Warning').pop()
    if (!warning) return ''
    return `${warning.reason ?? 'Warning'}: ${(warning.message ?? '').trim()}`
  } catch {
    return ''
  }
}

const NODE_PROBE_POD_PREFIX = 'yaac-cluster-check-node'

const PER_NODE_FIX =
  'Each node needs what a session pod needs from it: the runsc handler (the '
  + 'yaac-gvisor-install DaemonSet), the containerd `hosts.toml` for the registry, '
  + `and the ${GLOBAL_CLAIM_NAME} volume, which on kind is a hostPath into the data `
  + 'dir that the node sees through the data dir extraMount. The kubelet event '
  + 'quoted above names which is missing. `yaac cluster install` re-applies the first '
  + 'two on every node and renders the extraMount onto every node it creates; on a '
  + 'cloud cluster the volume itself has to attach on every node.'

/** Node names for a warn detail, capped so a wide cluster stays readable. */
function nodeList(names: string[]): string {
  return names.slice(0, 4).join(', ') + (names.length > 4 ? ` (+${names.length - 4} more)` : '')
}

/**
 * Per-node readiness (warn-level; skipped on a single node, which the
 * other gates already cover). On every node a workspace could land on, one
 * pod does what a workspace needs from that node: pull from the registry
 * (`Always`, so a cached image cannot hide a broken registry), run on the
 * gvisor RuntimeClass, and write the global claim at the workspace uid.
 * `nodeName` bypasses the scheduler so the answer is about that node; the
 * pod tolerates exactly what a workspace pod does. A pod that fails is
 * reported with the kubelet's event, which says which of the three broke.
 */
async function runPerNodeProbe(
  nodes: ClusterNode[],
  gvisorScheduling: GvisorScheduling,
  identity: InstallIdentity,
): Promise<CheckResult> {
  const result = (status: CheckResult['status'], detail: string, fix?: string): CheckResult =>
    ({ name: 'per-node', status, detail, ...(fix ? { fix } : {}) })
  if (nodes.length === 0) return result('warn', 'node list unavailable — per-node readiness unverified')
  if (nodes.length === 1) {
    return result('skip', 'skipped — single-node cluster (the gvisor and probe gates cover it)')
  }

  // `capable`: Ready, uncordoned, taints tolerated. `eligible`: also
  // matches the RuntimeClass nodeSelector. A capable node outside it is one
  // the gVisor installer has not reached, and cannot host a workspace.
  const capable = nodes.filter((n) => n.ready && n.schedulable)
  const eligible = capable.filter((n) =>
    Object.entries(gvisorScheduling.nodeSelector).every(([k, v]) => n.labels[k] === v))
  const skipped = nodes.filter((n) => !n.ready || !n.schedulable)
    .map((n) => `${n.name} (${n.ready ? n.excludedBecause : 'NotReady'})`)
  const skippedTail = skipped.length > 0 ? `; not swept: ${nodeList(skipped)}` : ''
  if (capable.length === 0) {
    return result('warn', `no node can schedule a session (see the nodes check above): ${nodeList(skipped)}`)
  }

  try {
    const image = await ensureProbeImage()
    const broken = capable.filter((n) => !eligible.includes(n))
      .map((n) => `${n.name} (no ${GVISOR_NODE_LABEL} label)`)
    const failures = await Promise.all(eligible.map(async (node, i) => {
      const podName = `${NODE_PROBE_POD_PREFIX}-${String(i)}`
      const { phase, logs, uid } = await runProbePod(podName, {
        // A pinned pod not done within a minute is stuck, not slow.
        timeoutMs: 60_000,
        spec: {
          nodeName: node.name,
          runtimeClassName: RUNTIME_CLASS_GVISOR,
          securityContext: workspaceSecurityContext(identity),
          volumes: GLOBAL_CLAIM_VOLUME.volumes,
        },
        container: {
          image,
          imagePullPolicy: 'Always',
          command: ['sh', '-c', 'f="/probe/.cluster-check-$1"; echo ok > "$f" && rm -f "$f"', '--', podName],
          volumeMounts: GLOBAL_CLAIM_VOLUME.volumeMounts,
        },
      })
      if (phase === 'Succeeded') return null
      // A container that exits nonzero (say, a write refused at the
      // workspace uid) raises no Warning event; its log says why.
      const log = logs.trim().split('\n').pop() ?? ''
      return `${node.name} (${await podFailureEvent(uid) || `phase ${phase}${log ? `: ${log}` : ''}`})`
    }))
    broken.push(...failures.filter((f): f is string => f !== null))
    if (broken.length > 0) {
      return result('warn', `a session pod cannot run on ${nodeList(broken)}${skippedTail}`, PER_NODE_FIX)
    }
    return result('pass', `a session pod pulled, ran sandboxed and wrote the ${GLOBAL_CLAIM_NAME} `
      + `claim at uid ${identity.uid} on all ${eligible.length} session-capable nodes${skippedTail}`)
  } catch (err) {
    return result('warn', `per-node readiness sweep errored (${k8sErrorSummary(err)})`)
  }
}

const ENFORCEMENT_PROBE_POD_NAME = 'yaac-cluster-check-enforcement'
const SANDBOX_PROBE_POD_NAME = 'yaac-cluster-check-egress'

/**
 * The one host a sandbox probe's registration allows, fetched over plain
 * HTTP since the probe image has no TLS client. It answers 200 to `/`.
 */
const PROBE_ALLOWED_HOST = 'example.com'

/** The verdict of one half of a probe gate; `warn` downgrades a pass. */
type ProbeHalf = { open: { detail: string; fix: string } } | { pass: string; warn?: string }

/** A Service's ClusterIP, or null when it does not exist. */
async function serviceIp(name: string, namespace: string): Promise<string | null> {
  const svc = await readObject<{ spec?: { clusterIP?: string } }>({
    apiVersion: 'v1', kind: 'Service', name, namespace,
  }).catch(() => null)
  return svc?.spec?.clusterIP || null
}

/**
 * The NFS servers behind the global volume, each resolved to an IP here
 * because the probe pod has no working DNS. Empty when the volume names
 * none; `ip` undefined when a name cannot be resolved.
 *
 * - csi-driver-nfs names one server, its `server` attribute.
 * - An EFS volume names a file system, served by one mount target per
 *   availability zone (`efsMountTargets`).
 */
async function sharedVolumeNfsServers(): Promise<Array<{ server: string; ip?: string }>> {
  const pvc = await readObject<RawPvcRead>({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: GLOBAL_CLAIM_NAME, namespace: k8sNamespace(),
  })
  const volume = pvc?.spec?.volumeName
  const csi = volume ? (await readPv(volume))?.spec?.csi : undefined
  if (csi?.driver === 'efs.csi.aws.com' && csi.volumeHandle) return efsMountTargets(csi.volumeHandle)
  const server = csi?.volumeAttributes?.server
  if (!server) return []
  if (isIP(server)) return [{ server, ip: server }]
  const svc = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(\.|$)/.exec(server)
  if (svc) {
    return [{ server, ip: await serviceIp(svc[1], svc[2]) ?? undefined }]
  }
  const ip = await dns.lookup(server).then((r) => r.address, () => undefined)
  return [{ server, ip }]
}

const EFS_RESOLVE_POD_NAME = 'yaac-cluster-check-efs-resolve'

/** A lowercase DNS name, the only thing interpolated into the resolver's script. */
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * The mount targets of the EFS file system an EFS volume handle
 * (`[efs:]<fs id>[:...]`) names: one per availability zone the nodes are
 * in, by EFS's zone-specific name `<zone>.<fs id>.efs.<region>.amazonaws.com`.
 * A handle may name a mount target by DNS name instead, which is used as
 * is. Those names resolve only inside the VPC, so a plain pod in the cluster
 * looks them up. A target that does not resolve, or whose name (a node's
 * zone label, the handle) is not a plain DNS name, is returned without an IP.
 */
async function efsMountTargets(handle: string): Promise<Array<{ server: string; ip?: string }>> {
  const fields = handle.split(':')
  const fs = fields[0] === 'efs' ? fields[1] : fields[0]
  let names: string[]
  if (fs.includes('.')) {
    names = [fs]
  } else {
    const labels = (await listObjects<{ metadata?: { labels?: Record<string, string> } }>('v1', 'Node'))
      .map((n) => n.metadata?.labels ?? {})
    const region = labels.map((l) => l['topology.kubernetes.io/region']).find(Boolean)
    if (!region) return [{ server: fs }]
    const zones = [...new Set(labels.map((l) => l['topology.kubernetes.io/zone']).filter(Boolean))]
    names = zones.length > 0
      ? zones.map((zone) => `${zone}.${fs}.efs.${region}.amazonaws.com`)
      : [`${fs}.efs.${region}.amazonaws.com`]
  }
  const lookups = names.filter((name) => DNS_NAME.test(name))
  const { logs } = lookups.length === 0 ? { logs: '' } : await runProbePod(EFS_RESOLVE_POD_NAME, {
    timeoutMs: 60_000,
    container: {
      image: await ensureProbeImage(),
      command: ['sh', '-c', lookups.map((name) => `echo "EFS_IP ${name} $(nslookup ${name} 2>/dev/null `
        + `| awk '/^Name:/ { f = 1 } f && /^Address/ { for (i = 2; i <= NF; i++) if ($i ~ /^[0-9.]+$/) { print $i; exit } }')"`)
        .join('; ')],
    },
  })
  const resolved = new Map(logs.split('\n').map((l) => l.trim().split(/\s+/))
    .filter(([tag, , ip]) => tag === 'EFS_IP' && ip && isIP(ip)).map(([, name, ip]) => [name, ip]))
  return names.map((name) => ({ server: name, ip: resolved.get(name) }))
}

/**
 * The egress gate, in three halves, each failing on its own:
 *  - enforcement: NetworkPolicy is enforced between two of yaac's own pods
 *    (`runEnforcementProbe`). This is all `--byo` asks of a cluster's CNI.
 *  - the sandbox: a pod in a workspace's shape reaches its allowlist and
 *    nothing else through the socket datapath (`runSandboxEgressProbe`).
 *  - the server's own egress (`runServerEgressProbe`).
 * Without its egress policy the proxy would let a workspace with a `*`
 * allowlist reach the server's node port as its owner, which no probe can
 * test, so the policy's presence is checked too.
 */
async function runNetworkPolicyProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const enforcement = await runEnforcementProbe()
    if ('open' in enforcement) return { name: 'egress', status: 'fail', ...enforcement.open }
    const sandbox = await runSandboxEgressProbe()
    if ('open' in sandbox) return { name: 'egress', status: 'fail', ...sandbox.open }
    if (await serviceIp(PROXY_APP_NAME, ns) && !await readObject({
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: PROXY_EGRESS_NP_NAME, namespace: ns,
    })) {
      return {
        name: 'egress', status: 'fail',
        detail: `the egress proxy has no ${PROXY_EGRESS_NP_NAME} NetworkPolicy — a session whose `
          + 'allowlist admits any host could reach the server through it as its owner',
        fix: 'Restart the yaac server (`yaac cluster restart`), which applies it on start.',
      }
    }
    const apiserverIp = await serviceIp('kubernetes', 'default')
    const server: ProbeHalf = apiserverIp
      ? await runServerEgressProbe(apiserverIp)
      : { pass: 'the apiserver has no ClusterIP to resolve, so the server\'s own egress is unverified' }
    if ('open' in server) return { name: 'egress', status: 'fail', ...server.open }
    const detail = `${enforcement.pass}; ${sandbox.pass}; ${server.pass}`
    return sandbox.warn !== undefined
      ? { name: 'egress', status: 'warn', detail: `${sandbox.warn}; ${detail}` }
      : { name: 'egress', status: 'pass', detail }
  } catch (err) {
    return {
      name: 'egress', status: 'fail',
      detail: `egress probe errored (${k8sErrorSummary(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

/**
 * Whether the cluster enforces NetworkPolicy, between two of yaac's own
 * pods. A runc pod the world-deny policy covers (any pod of the namespace
 * but the proxy and the server) must fail to dial the main registry and the
 * yaac server, whose ingress admits neither. A dropped connect is the only
 * answer policy gives, so this half asserts on connects. The policies
 * around yaac's own pods rest on this; no sandbox does, having no
 * interface.
 */
async function runEnforcementProbe(): Promise<ProbeHalf> {
  const targets = [
    { key: 'REGISTRY', ip: await serviceIp(REGISTRY_SERVICE_NAME, REGISTRY_NAMESPACE), port: REGISTRY_SERVICE_PORT, what: 'the image registry' },
    { key: 'SERVER', ip: await serviceIp(SERVER_APP_NAME, k8sNamespace()), port: SERVER_POD_PORT, what: 'the yaac server' },
  ].filter((t): t is typeof t & { ip: string } => t.ip !== null)
  if (targets.length === 0) return { pass: 'no registry or server to dial, so policy enforcement is unverified' }
  const { phase, logs } = await runProbePod(ENFORCEMENT_PROBE_POD_NAME, {
    timeoutMs: 60_000,
    labels: { app: ENFORCEMENT_PROBE_POD_NAME },
    container: {
      image: await ensureProbeImage(),
      command: ['sh', '-c', targets.map((t) => `nc -w 4 ${t.ip} ${String(t.port)} </dev/null >/dev/null 2>&1`
        + ` && echo NP_${t.key}_OPEN || echo NP_${t.key}_LOCKED; `).join('') + 'echo NP_DONE'],
    },
  })
  if (phase !== 'Succeeded' || !logs.includes('NP_DONE')) {
    return { open: { detail: `the enforcement probe pod produced no verdict (phase ${phase})`, fix: KIND_SETUP_FIX } }
  }
  const open = targets.filter((t) => logs.includes(`NP_${t.key}_OPEN`))
  if (open.length > 0) {
    return { open: {
      detail: `a pod the ${EGRESS_WORLD_DENY_NAME} policy covers reached ${open.map((t) => t.what).join(' and ')} `
        + '— the cluster is not enforcing NetworkPolicy',
      fix: 'yaac\'s own pods are walled by plain networking.k8s.io/v1 NetworkPolicy, which some engine '
        + 'must enforce. Re-run `yaac cluster install`, which installs Calico on kind. On a byo '
        + 'cluster, turn on the network policy engine its provider offers (any engine, Cilium included).',
    } }
  }
  return { pass: `NetworkPolicy is enforced (a walled pod cannot dial ${targets.map((t) => t.what).join(', nor ')})` }
}

/**
 * Run `script` in a sandbox in a workspace's shape: the gVisor runtime with
 * no network interface, netshim and its socket directory, netshim's DNS,
 * root with no raw socket, and a registration of its own allowing
 * `allowedHosts` and naming `clusterServices`. Every dial it makes goes
 * through netd's relay and the proxy. The registration and the pod are
 * removed afterwards.
 */
async function runSandboxProbe(name: string, opts: {
  allowedHosts: string[]
  clusterServices?: string[]
  script: string
  timeoutMs: number
}): Promise<{ phase: string; logs: string }> {
  const probeId = `check-${crypto.randomBytes(4).toString('hex')}`
  const registration = {
    rules: [], allowedHosts: opts.allowedHosts, projectId: 'cluster-check', owner: 'none',
    ...(opts.clusterServices ? { clusterServices: opts.clusterServices } : {}),
  }
  await applyObject(buildRegistrationConfigMapManifest(probeId, 'cluster-check', registration))
  try {
    return await runProbePod(name, {
      timeoutMs: opts.timeoutMs,
      // No install id, so no workspace listing sees it; netd's relay finds
      // it by this label and its `sockets` volume.
      labels: { [LABEL_WORKSPACE_ID]: probeId },
      spec: {
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        ...SANDBOX_DNS,
        initContainers: [netshimContainer(await mountdImage())],
        volumes: [socketVolume(`${probeId}.${crypto.randomBytes(4).toString('hex')}`)],
      },
      container: {
        image: await ensureProbeImage(),
        securityContext: { runAsUser: 0, capabilities: { drop: ['NET_RAW'] } },
        command: ['sh', '-c', opts.script],
      },
    })
  } finally {
    await deleteObject({
      apiVersion: 'v1', kind: 'ConfigMap', name: proxyRegistrationName(probeId), namespace: k8sNamespace(),
    }).catch(() => {})
  }
}

/** Whether the proxy and netd are up for a sandbox probe, or why not. */
async function sandboxDatapathAbsent(): Promise<string | null> {
  if (!await serviceIp(PROXY_APP_NAME, k8sNamespace())) return 'the proxy is not deployed yet (it deploys with the first workspace)'
  const netd = await daemonSetReadiness(NETD_APP_NAME, k8sNamespace()).catch(() => null)
  if (!netd?.ok) return `${NETD_APP_NAME} is not ready`
  return null
}

/** One address the sandbox probe must be refused, and how a pass names it. */
interface SandboxTarget {
  /** Marker infix: the probe prints `EG_<key> <status>`. */
  key: string
  url: string
  what: string
}

/**
 * The plan's acceptance test (docs/workspace-egress.md "What a sandbox
 * sees"), from a sandbox in a workspace's shape, as root: a request to
 * the server, the apiserver, a node, another sandbox, a literal internet
 * address and the shared tier's NFS servers each completes with the
 * proxy's 403, while the allowlisted host answers. A dial here always
 * connects, since netshim takes it, so each is judged on the request's
 * status, never on a connect, and a request with no answer is a broken
 * datapath. The container must also see no unix socket: only netshim's
 * container mounts the socket directory.
 */
async function runSandboxEgressProbe(): Promise<ProbeHalf> {
  const ns = k8sNamespace()
  const absent = await sandboxDatapathAbsent()
  if (absent) return { pass: `${absent}, so sandbox egress is unverified` }
  const [serverIp, apiserver, node, peer, nfs] = await Promise.all([
    serviceIp(SERVER_APP_NAME, ns),
    apiserverEndpoints().then((a) => ({ ip: a.cidrs.find((c) => !c.includes(':'))?.replace(/\/32$/, ''), port: a.ports[0] })),
    nodeIpBlocks().then((cidrs) => cidrs.find((c) => !c.includes(':'))?.replace(/\/32$/, '')),
    runningSandboxIp(),
    sharedVolumeNfsServers(),
  ])
  const targets: SandboxTarget[] = [
    ...(serverIp ? [
      { key: 'SERVER', url: `http://${serverIp}:${String(SERVER_POD_PORT)}/api/health`, what: 'the yaac server by address' },
      {
        key: 'SERVER_NAME',
        url: `http://${SERVER_APP_NAME}.${ns}.svc.cluster.local:${String(SERVER_POD_PORT)}/api/health`,
        what: 'the yaac server by name',
      },
    ] : []),
    // Port 443 would go to the proxy's TLS handler, which this client
    // cannot speak to; any other port of the same address shows the
    // request goes to the proxy.
    ...(apiserver.ip ? [{
      key: 'API', url: `http://${apiserver.ip}:${String(apiserver.port && apiserver.port !== 443 ? apiserver.port : 80)}/`,
      what: 'the apiserver',
    }] : []),
    ...(node ? [{ key: 'NODE', url: `http://${node}:10250/`, what: `node ${node}'s kubelet` }] : []),
    ...(peer ? [{ key: 'PEER', url: `http://${peer}:${String(POD_STREAM_PORT)}/`, what: 'another sandbox' }] : []),
    { key: 'WORLD', url: 'http://1.1.1.1/', what: 'a literal internet address' },
    ...nfs.flatMap((n, i) => (n.ip ? [{ key: `NFS${String(i)}`, url: `http://${n.ip}:${String(NFS_PORT)}/`, what: `the NFS server ${n.server}` }] : [])),
  ]
  const script = [
    // busybox wget prints the status line with -S, and keeps no body on an
    // error status; `none` is a request that got no answer at all.
    'eg() { st=$(wget -S -T 20 -O /dev/null "$2" 2>&1 | sed -n \'s|^ *HTTP/1\\.[01] \\([0-9][0-9][0-9]\\).*|\\1|p\' | head -1); '
      + 'echo "EG_$1 ${st:-none}"; }',
    `eg ALLOWED http://${PROBE_ALLOWED_HOST}/`,
    ...targets.map((t) => `eg ${t.key} ${t.url}`),
    's=$(find / -type s ! -path "/proc/*" ! -path "/sys/*" 2>/dev/null | head -3 | tr "\\n" " "); echo "EG_SOCKETS ${s:-none}"',
    'echo EG_DONE',
  ].join('\n')
  const { phase, logs } = await runSandboxProbe(SANDBOX_PROBE_POD_NAME, {
    allowedHosts: [PROBE_ALLOWED_HOST], script, timeoutMs: 180_000,
  })
  const status = (key: string): string | undefined => new RegExp(`^EG_${key} (\\S+)`, 'm').exec(logs)?.[1]
  const fix = 'Every sandbox connection crosses netshim, netd\'s relay and the proxy (docs/workspace-egress.md). '
    + `Inspect \`kubectl -n ${ns} logs ds/${NETD_APP_NAME} -c relay\` and \`kubectl -n ${ns} logs deploy/${PROXY_APP_NAME}\`, `
    + 'and restart the yaac server (`yaac cluster restart`), which re-applies both.'
  if (phase !== 'Succeeded' || !logs.includes('EG_DONE')) {
    return { open: { detail: `the sandbox egress probe pod produced no verdict (phase ${phase})`, fix } }
  }
  const allowed = status('ALLOWED')
  if (allowed === 'none' || allowed === undefined) {
    return { open: { detail: `a sandbox's request to ${PROBE_ALLOWED_HOST}, which its allowlist admits, got no answer — `
      + 'sandboxes have no egress', fix } }
  }
  // A 5xx is the proxy's own answer when it reaches no upstream (a cluster
  // with no internet): the request completed through the datapath, which
  // the targets' 403s prove too, so that is a warning, not a failure.
  const noUpstream = /^5/.test(allowed)
  if (!/^[23]/.test(allowed) && !noUpstream) {
    return { open: { detail: `a sandbox's request to ${PROBE_ALLOWED_HOST}, which its allowlist admits, was answered ${allowed}`, fix } }
  }
  const silent = targets.filter((t) => status(t.key) === 'none' || status(t.key) === undefined)
  if (silent.length > 0) {
    return { open: { detail: `a sandbox's request to ${silent.map((t) => t.what).join(' and ')} got no answer, where the `
      + 'proxy refuses it — the request did not complete, so the datapath is broken', fix } }
  }
  const reached = targets.filter((t) => status(t.key) !== '403')
  if (reached.length > 0) {
    return { open: {
      detail: `a sandbox reached ${reached.map((t) => `${t.what} (answered ${status(t.key) ?? '?'})`).join(' and ')}, `
        + 'which the proxy must refuse',
      fix,
    } }
  }
  const sockets = /^EG_SOCKETS (.*)$/m.exec(logs)?.[1]?.trim()
  if (sockets !== 'none') {
    return { open: {
      detail: `a sandbox's own container sees unix sockets (${sockets ?? '?'}) — with host-uds on, it could connect to `
        + 'the node sockets behind them',
      fix: 'Only netshim\'s container may mount the socket directory. Restart the yaac server so pods are made in their current shape.',
    } }
  }
  const unverified = [
    ...(peer ? [] : ['no other sandbox ran to try']),
    ...nfs.filter((n) => !n.ip).map((n) => `NFS server ${n.server} unresolvable from here — unverified`),
  ]
  return {
    pass: `a sandbox ${noUpstream ? 'reaches the proxy' : `reaches ${PROBE_ALLOWED_HOST}`} and is refused `
      + `${targets.map((t) => t.what).join(', ')}${unverified.length ? ` (${unverified.join('; ')})` : ''}, and sees no node socket`,
    ...(noUpstream
      ? { warn: `the proxy answered ${allowed} to a sandbox's request for ${PROBE_ALLOWED_HOST}: it reaches no upstream, `
        + 'so allowlisted hosts were not shown to answer (a cluster with no internet)' }
      : {}),
  }
}

/** A running workspace pod's address, for the sandbox probe to try; null with none. */
async function runningSandboxIp(): Promise<string | null> {
  return (await listObjects<{ status?: { podIP?: string } }>('v1', 'Pod', {
    namespace: k8sNamespace(),
    labelSelector: `${LABEL_WORKSPACE_ID},${LABEL_INSTALL_ID}=${installId()}`,
    fieldSelector: 'status.phase=Running',
  })).find((p) => p.status?.podIP)?.status?.podIP ?? null
}

const SERVER_EGRESS_PROBE_POD_NAME = 'yaac-cluster-check-server-egress'

/** The kubelet's port, which every node listens on. */
const KUBELET_PORT = 10250

/**
 * The `egress` gate's server half (docs/server-in-cluster.md "The server's
 * own egress"). A pod under the server's egress policy (labelled with its
 * role, on runc like the server) must reach the apiserver Service, which
 * shows the policy names the apiserver's current endpoints, and resolve a
 * name through the cluster's DNS, which every clone needs. It must not reach
 * a node's kubelet, a real listener on every node, nor the link-local
 * metadata address (which only a cloud node serves, so on kind that denial
 * proves nothing). The main registry and the proxy are not dialed: their
 * ingress admits only `app: yaac-server`, which the probe lacks. Returns
 * the failure, or how a pass reads.
 */
async function runServerEgressProbe(
  apiserverIp: string,
): Promise<{ open: { detail: string; fix: string } } | { pass: string }> {
  const ns = k8sNamespace()
  if (!await serviceIp(SERVER_APP_NAME, ns)) return { pass: 'server not deployed in-cluster — its egress unverified' }
  const fix = 'Run `yaac cluster restart`, which renders the server\'s egress policy from this machine.'
  if (!await readObject({
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: SERVER_EGRESS_NP_NAME, namespace: ns,
  })) {
    return { open: {
      detail: `the yaac server has no ${SERVER_EGRESS_NP_NAME} NetworkPolicy — a git remote a user `
        + 'names can reach the cluster\'s internal addresses through it',
      fix,
    } }
  }
  const node = (await nodeIpBlocks()).find((cidr) => !cidr.includes(':'))?.replace(/\/32$/, '')
  const targets: Array<[key: string, ip: string, port: number]> = [
    ['API', apiserverIp, 443],
    ...(node ? [['KUBELET', node, KUBELET_PORT] as [string, string, number]] : []),
    ['METADATA', '169.254.169.254', 80],
  ]
  const { phase, logs } = await runProbePod(SERVER_EGRESS_PROBE_POD_NAME, {
    timeoutMs: 60_000,
    labels: { [LABEL_ROLE]: ROLE_SERVER },
    container: {
      image: await ensureProbeImage(),
      command: ['sh', '-c', [
        ...targets.map(([key, ip, port]) =>
          `nc -w 4 ${ip} ${String(port)} </dev/null >/dev/null 2>&1 && echo SRV_${key}_OPEN || echo SRV_${key}_LOCKED`),
        // The short name too, for a cluster whose domain is not cluster.local.
        // Read by its answer, a `Name:` line, as some busybox builds exit 0
        // on a failed lookup.
        '{ nslookup kubernetes.default.svc.cluster.local; nslookup kubernetes.default.svc; } 2>/dev/null '
          + '| grep -q \'^Name:\' && echo SRV_DNS_OK || echo SRV_DNS_FAIL',
      ].join('; ')],
    },
  })
  if (phase !== 'Succeeded' || !logs.includes('SRV_API_')) {
    return { open: { detail: `server egress probe pod ended in phase ${phase}, with no verdict`, fix: KIND_SETUP_FIX } }
  }
  if (logs.includes('SRV_API_LOCKED')) {
    return { open: {
      detail: `the ${SERVER_EGRESS_NP_NAME} NetworkPolicy does not admit the apiserver at its current `
        + 'endpoints — the server cannot reach the cluster to correct it',
      fix,
    } }
  }
  if (logs.includes('SRV_DNS_FAIL')) {
    return { open: {
      detail: `a pod under the ${SERVER_EGRESS_NP_NAME} NetworkPolicy could not resolve a name through the `
        + 'cluster\'s DNS — every clone and fetch the server makes would fail to resolve its host',
      fix,
    } }
  }
  const reached = [
    ...(logs.includes('SRV_KUBELET_OPEN') ? [`the kubelet on node ${node ?? ''}`] : []),
    ...(logs.includes('SRV_METADATA_OPEN') ? ['the link-local metadata address'] : []),
  ]
  if (reached.length > 0) {
    return { open: {
      detail: `a pod under the server's egress policy reached ${reached.join(' and ')} — a git remote `
        + 'a user names could reach it too',
      fix,
    } }
  }
  return { pass: `the server's own dials reach the apiserver and DNS, but not a node's kubelet nor link-local metadata` }
}

const NPM_CACHE_PROBE_POD_NAME = 'yaac-cluster-check-npm-cache'

/** A small, long-published tarball, fetched with its packument the way
 *  pnpm fetches one. */
const NPM_CACHE_PROBE_PATHS = ['is-number', 'is-number/-/is-number-7.0.0.tgz']

/** A function because the namespace must not be read at import time. */
function npmCacheFix(): string {
  return 'Re-run `yaac cluster install`, which deploys the npm cache. Inspect it with '
    + `\`kubectl -n ${k8sNamespace()} get pods,pvc -l app=${NPM_CACHE_APP_NAME}\` and `
    + `\`kubectl -n ${k8sNamespace()} logs deploy/${NPM_CACHE_APP_NAME} --all-containers\`.`
}

/**
 * Check the npm cache serves workspaces: a sandbox whose registration names
 * the cache in `clusterServices`, as a cache-using workspace's does, fetches
 * a packument and tarball by the cache's name, which netd's relay and the
 * proxy carry to it. This covers the cache's policies, the proxy's path to
 * it, and the cache's route to npmjs.
 *
 * No ready cache is a warn: new workspaces then install from npmjs
 * (`servingNpmCacheUrl`), and so is a proxy not deployed yet. A ready cache
 * that fails to serve is a fail, since new workspaces would install
 * through it.
 */
async function runNpmCacheProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const ip = await serviceIp(NPM_CACHE_APP_NAME, ns)
    if (!ip || await servingNpmCacheUrl() === null) {
      return {
        name: 'npm-cache', status: 'warn',
        detail: `${ip ? 'the npm cache has no ready pod' : 'no npm cache in this install'} `
          + '— workspaces install from npmjs',
        fix: npmCacheFix(),
      }
    }
    const absent = await sandboxDatapathAbsent()
    if (absent) {
      return { name: 'npm-cache', status: 'warn', detail: `${absent}, so the cache is unverified from a sandbox` }
    }
    const host = npmCacheHost()
    const fetches = NPM_CACHE_PROBE_PATHS
      .map((p) => `wget -q -T 60 -O /dev/null http://${host}/${p}`)
      .join(' && ')
    const { phase, logs } = await runSandboxProbe(NPM_CACHE_PROBE_POD_NAME, {
      allowedHosts: [],
      clusterServices: [host],
      script: `(${fetches}) && echo NPM_CACHE_OK || echo NPM_CACHE_FAILED`,
      timeoutMs: 150_000,
    })
    if (phase === 'Succeeded' && logs.includes('NPM_CACHE_OK')) {
      return {
        name: 'npm-cache', status: 'pass',
        detail: `a sandbox fetched a package through ${NPM_CACHE_APP_NAME}, by way of the proxy`,
      }
    }
    return {
      name: 'npm-cache', status: 'fail',
      detail: `a sandbox could not fetch a package through ${NPM_CACHE_APP_NAME} `
        + `(phase ${phase}${logs.trim() ? `, logs: ${logs.trim().slice(0, 80)}` : ''}), `
        + 'so every session\'s pnpm install fails',
      fix: npmCacheFix(),
    }
  } catch (err) {
    return {
      name: 'npm-cache', status: 'fail',
      detail: `npm cache probe errored (${k8sErrorSummary(err)})`,
      fix: npmCacheFix(),
    }
  }
}

const SITES_PROBE_POD_NAME = 'yaac-cluster-check-sites'

/**
 * The sites gate: site traffic flows through the two tunnels and the
 * router, so none of them may reach the server (which treats a loopback
 * `Host` as its owner), the proxy's control port, or netd's stream port,
 * which carries the server's streams into workspaces (docs/server-in-cluster.md
 * "The site edge"). A probe pod labelled as each, held to its policies,
 * must fail to dial all three. One labelled as a tunnel must also fail to
 * dial netd's site port, which takes no secret and so is the router's
 * alone, while the router's must reach it, as every site request does
 * (docs/public-sites.md "The router"). One labelled as a Cloudflare pod
 * must also fail to dial the router's tailnet listener, which trusts the
 * login a request carries. The tailnet tunnel is the exception for the
 * server while the install names a server name, since it fronts the server
 * at that name, so its probe skips the server.
 *
 * With a Cloudflare tunnel installed, one holding no connection is a warn.
 * With a tailnet tunnel, one not joined or with no certificate is a warn,
 * and so, where this machine is on the tailnet, is a site domain that does
 * not resolve to the tunnel.
 */
async function runSitesProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  const fix = 'The edge\'s NetworkPolicies must admit nothing but the tunnels\' outside peers, DNS, the router '
    + 'and release pods. Re-run `yaac cluster install`, which re-applies them.'
  try {
    const netd = (await listObjects<{ status?: { podIP?: string } }>('v1', 'Pod', {
      namespace: ns, labelSelector: `app=${NETD_APP_NAME}`, fieldSelector: 'status.phase=Running',
    })).find((p) => p.status?.podIP)?.status?.podIP ?? null
    const targets = [
      { key: 'SERVER', ip: await serviceIp(SERVER_APP_NAME, ns), port: SERVER_POD_PORT, what: 'the yaac server' },
      { key: 'PROXY', ip: await serviceIp(PROXY_APP_NAME, ns), port: PROXY_PORT, what: 'the proxy\'s control port' },
      { key: 'NETD_STREAM', ip: netd, port: NETD_STREAM_PORT, what: 'netd\'s stream port, into workspaces' },
    ].filter((t): t is typeof t & { ip: string } => t.ip !== null)
    if (targets.length === 0) {
      return {
        name: 'sites', status: 'warn',
        detail: 'no server, proxy or netd is running to dial — the site edge\'s wall is unverified',
      }
    }
    const netdSite = netd === null ? [] : [{
      key: 'NETD_SITE', ip: netd, port: NETD_SITE_PORT, what: 'netd\'s site port',
    }]
    const routerIp = await serviceIp(SITE_ROUTER_APP_NAME, ns)
    const routerTailnet = routerIp === null ? [] : [{
      key: 'ROUTER_TAILNET', ip: routerIp, port: SITE_ROUTER_TAILNET_PORT, what: 'the router\'s tailnet listener',
    }]
    const serverName = (await siteTailnetDevice())?.serverName
    const probes = [
      { app: SITE_TUNNEL_CLOUDFLARE_APP_NAME, suffix: 'cloudflare', targets: [...targets, ...routerTailnet, ...netdSite] },
      {
        app: SITE_TUNNEL_TAILNET_APP_NAME,
        suffix: 'tailnet',
        targets: [...serverName ? targets.filter((t) => t.key !== 'SERVER') : targets, ...netdSite],
      },
      // The router's dials include the one it must make.
      { app: SITE_ROUTER_APP_NAME, suffix: 'router', targets: [...targets, ...netdSite] },
    ]
    const image = await ensureProbeImage()
    const runs = await Promise.all(probes.map(async (probe) => ({
      ...probe,
      ...await runProbePod(`${SITES_PROBE_POD_NAME}-${probe.suffix}`, {
        timeoutMs: 60_000,
        // Runs on runc, as the edge does, and never matches its Services.
        labels: { app: probe.app },
        container: {
          image,
          command: ['sh', '-c', probe.targets.map((t) => `nc -w 4 ${t.ip} ${String(t.port)} </dev/null >/dev/null 2>&1`
            + ` && echo SITE_${t.key}_OPEN || echo SITE_${t.key}_LOCKED; `).join('') + 'echo SITES_DONE'],
        },
      }),
    })))
    const stalled = runs.find((r) => r.phase !== 'Succeeded' || !r.logs.includes('SITES_DONE'))
    if (stalled) {
      return {
        name: 'sites', status: 'fail',
        detail: `the ${stalled.app} probe pod produced no verdict (phase ${stalled.phase})`,
        fix: KIND_SETUP_FIX,
      }
    }
    const mustReach = (app: string, key: string): boolean => app === SITE_ROUTER_APP_NAME && key === 'NETD_SITE'
    const open = runs.flatMap((r) => r.targets
      .filter((t) => !mustReach(r.app, t.key) && r.logs.includes(`SITE_${t.key}_OPEN`))
      .map((t) => `a pod labelled as ${r.app} reached ${t.what}`))
    const cutOff = runs.flatMap((r) => r.targets
      .filter((t) => mustReach(r.app, t.key) && r.logs.includes(`SITE_${t.key}_LOCKED`)))
    if (cutOff.length > 0) {
      return {
        name: 'sites', status: 'fail',
        detail: `a pod labelled as ${SITE_ROUTER_APP_NAME} could not dial netd's site port, which every site request crosses`,
        fix: `netd's ingress policy must admit the router on its site port. Restart the yaac server, which re-applies it.`,
      }
    }
    if (open.length > 0) {
      return {
        name: 'sites', status: 'fail',
        detail: `${open.join('; ')} — site traffic passes through these pods`,
        fix,
      }
    }
    const notes = [`the site tunnels and router cannot dial ${targets.map((t) => t.what).join(', nor ')}`
      + (serverName ? ` (bar the tailnet tunnel to the server, which it fronts at ${serverName})` : '')
      + (netd === null ? '' : ', and only the router reaches netd\'s site port')]
    const warns: Array<{ detail: string; fix: string }> = []
    const cloudflare = await siteCloudflareStatus()
    if (cloudflare === 'disconnected') {
      warns.push({
        detail: 'the Cloudflare tunnel holds no connection, so no public site is reachable',
        fix: 'Check the tunnel token (re-run `yaac cluster install` with CF_TUNNEL_TOKEN) and that this '
          + `network lets out TCP and UDP 7844. Inspect with \`kubectl -n ${ns} logs deploy/${SITE_TUNNEL_CLOUDFLARE_APP_NAME}\`.`,
      })
    } else if (cloudflare === 'connected') {
      notes.push('the Cloudflare tunnel is connected')
    }
    const tailnet = await siteTailnetStatus()
    if (tailnet === 'joining') {
      warns.push({
        detail: 'the tailnet tunnel has not joined the tailnet, so no tailnet site is reachable',
        fix: 'Check its auth key (re-run `yaac cluster install` with TS_SITE_AUTHKEY) and inspect with '
          + `\`kubectl -n ${ns} logs deploy/${SITE_TUNNEL_TAILNET_APP_NAME} -c tailscaled\`.`,
      })
    } else if (tailnet === 'no-certificate') {
      warns.push({
        detail: 'the tailnet tunnel has no certificate, so no tailnet site answers',
        fix: `Put a wildcard certificate for the site domain in the Secret ${SITE_TUNNEL_TAILNET_TLS_SECRET_NAME} `
          + 'in this namespace, by hand or as a cert-manager Certificate\'s secretName with a DNS-01 issuer.',
      })
    } else if (tailnet === 'ready') {
      const dnsWarn = await siteDomainResolution()
      if (dnsWarn) warns.push(dnsWarn)
      else notes.push('the tailnet tunnel is serving')
    }
    if (warns.length > 0) {
      return {
        name: 'sites', status: 'warn',
        detail: `${notes[0]}, but ${warns.map((w) => w.detail).join('; ')}`,
        fix: warns.map((w) => w.fix).join(' '),
      }
    }
    return { name: 'sites', status: 'pass', detail: notes.join('; ') }
  } catch (err) {
    return { name: 'sites', status: 'fail', detail: `sites probe errored (${k8sErrorSummary(err)})`, fix }
  }
}

/**
 * A warn when this machine is on the tailnet and a name under the site
 * domain does not resolve to the tailnet tunnel, which is what the
 * tailnet's split DNS setting does. Null when it resolves, when there is
 * no tunnel, or when this machine is off the tailnet and cannot tell.
 */
async function siteDomainResolution(): Promise<{ detail: string; fix: string } | null> {
  const device = await siteTailnetDevice()
  if (!device || device.addresses.length === 0) return null
  const onTailnet = await execFileAsync('tailscale', ['status', '--json'], { timeout: 5_000 })
    .then(({ stdout }) => (JSON.parse(stdout) as { BackendState?: string }).BackendState === 'Running')
    .catch(() => false)
  if (!onTailnet) return null
  const name = `yaac-cluster-check.${device.siteDomain}`
  const resolved = await dns.resolve4(name).catch(() => [] as string[])
  if (resolved.some((ip) => device.addresses.includes(ip))) return null
  return {
    detail: `${name} does not resolve to the tailnet tunnel (${device.addresses.join(', ')})`,
    fix: `In the Tailscale admin console's DNS settings, add ${device.addresses[0]} as a nameserver restricted `
      + `to ${device.siteDomain} (split DNS).`,
  }
}

interface RawContainerPod {
  status?: {
    containerStatuses?: Array<{
      name?: string
      ready?: boolean
      state?: Record<string, { reason?: string } | undefined>
    }>
  }
}

/**
 * `container: reason` for every not-ready netd container. It only adds
 * detail to a failure already reported.
 */
function netdNotReadyContainers(pods: RawContainerPod[]): string[] {
  const out: string[] = []
  for (const pod of pods) {
    for (const c of pod.status?.containerStatuses ?? []) {
      if (c.ready !== false || !c.name) continue
      const reason = Object.values(c.state ?? {})[0]?.reason ?? 'not ready'
      if (!out.includes(`${c.name}: ${reason}`)) out.push(`${c.name}: ${reason}`)
    }
  }
  return out
}

/**
 * A DaemonSet's `ready/desired` count, `ok` when every scheduled pod is
 * Ready and there is at least one; null when the DaemonSet is absent.
 */
async function daemonSetReadiness(name: string, namespace: string): Promise<{ ok: boolean; ratio: string } | null> {
  const ds = await readObject<{ status?: { numberReady?: number; desiredNumberScheduled?: number } }>({
    apiVersion: 'apps/v1', kind: 'DaemonSet', name, namespace,
  })
  if (!ds) return null
  const ready = ds.status?.numberReady ?? 0
  const wanted = ds.status?.desiredNumberScheduled ?? 0
  return { ok: ready > 0 && ready === wanted, ratio: `${String(ready)}/${String(wanted)}` }
}

/**
 * The datapath gate: netd must be Ready on every node. Its relay carries
 * every sandbox's traffic, so a node without it has sandboxes with no
 * egress, terminals and sites (they fail closed).
 */
async function runDatapathCheck(): Promise<CheckResult> {
  try {
    const netd = await daemonSetReadiness(NETD_APP_NAME, k8sNamespace()).catch(() => null)
    if (!netd?.ok) {
      const pods = await listObjects<RawContainerPod>('v1', 'Pod', {
        namespace: k8sNamespace(), labelSelector: `app=${NETD_APP_NAME}`,
      }).catch(() => [])
      // Name the unhealthy container: the DaemonSet counts cannot tell the
      // relay and netd apart.
      const blocked = netdNotReadyContainers(pods)
      return {
        name: 'datapath', status: 'fail',
        detail: netd
          ? `${NETD_APP_NAME} is ${netd.ratio} ready — sandboxes on the other nodes have no traffic`
            + (blocked.length ? ` (${blocked.join(', ')})` : '')
          : `${NETD_APP_NAME} is not deployed — sandboxes have no traffic`,
        fix: 'netd\'s relay carries every sandbox\'s traffic. `yaac cluster install` '
          + 're-applies it (the server also re-ensures it whenever it '
          + 'brings the proxy up). Inspect both containers with '
          + `\`kubectl -n ${k8sNamespace()} logs ds/${NETD_APP_NAME} -c relay\` and `
          + '`-c netd`.',
      }
    }
    return { name: 'datapath', status: 'pass', detail: `${NETD_APP_NAME} ready on every node (${netd.ratio})` }
  } catch (err) {
    return {
      name: 'datapath', status: 'fail',
      detail: `could not query the datapath components (${k8sErrorSummary(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

/**
 * The builder-pod guard is a ValidatingAdmissionPolicy, and
 * `ensureBuilderRoleGuard` refuses to proceed without the API, so no image
 * can be built. Uses the same `vapAvailable` test as the guard.
 */
async function runVapAvailabilityCheck(): Promise<CheckResult> {
  let available: boolean
  try {
    available = await vapAvailable()
  } catch (err) {
    return {
      name: 'vap', status: 'fail',
      detail: `could not query the ValidatingAdmissionPolicy API (${k8sErrorSummary(err)})`,
    }
  }
  if (available) {
    return {
      name: 'vap', status: 'pass',
      detail: 'ValidatingAdmissionPolicy API available (builder-pod guard)',
    }
  }
  return {
    name: 'vap', status: 'fail',
    detail: 'ValidatingAdmissionPolicy API unavailable',
    fix: 'Sandboxed image builds reserve their pod label with a '
      + 'ValidatingAdmissionPolicy (kubernetes >= 1.30, enabled by '
      + 'default) and fail closed without it, so no workspace image can '
      + 'be built. This needs a newer cluster: `yaac cluster delete`, '
      + 'then `yaac cluster install`.',
  }
}
