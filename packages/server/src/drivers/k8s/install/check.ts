import {
  buildProxyIngressNpManifest,
  buildWorkspaceEgressNpManifest,
  cniVethPrefix,
  ensureBuilderImage,
  ensureNamespace,
  nodeIpBlocks,
  servingNpmCacheUrl,
  vapAvailable,
} from '#drivers/k8s/cluster'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import { isIP } from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GLOBAL_CLAIM_NAME,
  GVISOR_NODE_LABEL,
  LABEL_CLAIM,
  LABEL_DATA_DIR_HASH,
  LABEL_INSTALL_ID,
  LABEL_NPM_CACHE,
  LABEL_WORKSPACE_ID,
  NESTED_ENGINE_CAPS,
  NETD_APP_NAME,
  NPM_CACHE_APP_NAME,
  NPM_CACHE_PORT,
  NODE_TASKSMAX_LIVE,
  NODE_TUNING_SYSCTLS,
  PROXY_APP_NAME,
  SERVER_APP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_INGRESS_NP_NAME,
  PROXY_EGRESS_NP_NAME,
  SERVER_LOCAL_CLAIM_NAME,
  SERVER_POD_PORT,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  TRANSPARENT_HTTPS_PORT,
  buildPriorityClassManifests,
  dataDirHash,
  execFileAsync,
  formatTaint,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  runPodToCompletion,
  runtimeClassSpec,
  installSecurityContext,
  kubectlErrorSummary,
  untoleratedTaints,
  workspaceIdLabels,
} from '#drivers/k8s/substrate'
import type { InstallIdentity, NodeTaint, PodToleration } from '#drivers/k8s/substrate'
import { assessVethSource, probeWorkloadVeths } from './cni-adopt'
import { GVISOR_INSTALLER_APP_NAME } from './gvisor-installer'
import { deployedInstallIdentity } from './server-deploy'
import { isNfsFamily } from './storage'
import {
  hostNodeArchitecture,
  nodeArchitectureProblems,
  nodeOsProblems,
  type PlatformNode,
} from './byo-gates'
import { readServerConfig } from '@yaac/shared/server-config'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  pushImageToRegistry,
  registryEndpoint,
  registryHost,
  registryReachable,
} from '#drivers/k8s/container'
import { PACKAGE_ROOT, globalRoot, serverLocalRoot } from '@yaac/shared/paths'
import type { CheckResult } from '@yaac/shared/types'

/** Probe image used for the end-to-end registry-pull + hostPath check. */
const PROBE_SOURCE_IMAGE = 'docker.io/library/busybox:1.36'
const PROBE_LOCAL_TAG = 'yaac-cluster-probe:busybox-1.36'
const PROBE_POD_NAME = 'yaac-cluster-check'

const KIND_SETUP_FIX = [
  'Create a kind cluster wired for yaac — or restart one a host reboot',
  'left stopped — by running:',
  '  yaac cluster install',
  'It provisions the podman machine (macOS), the kind cluster (home and',
  'node-local extraMounts), Calico, the kind node fixups, every built-in',
  'image, the in-cluster registry, and the two storage claims.',
].join('\n')

/**
 * Settings of the kind node container that install applies and the
 * node-fixups check verifies. Node-level tuning that the installer
 * DaemonSet can apply lives in substrate/node-tuning.ts instead.
 */
export const NODE_PIDS_LIMIT = 32768
/**
 * kubelet cAdvisor housekeeping interval (default 10s). Each tick readlinks
 * every open fd in each container, and a gVisor sandbox holds ~9k host fds,
 * so at the default (and even at 60s) kubelet burned 1-2 cores. At 300s
 * node-level stats are slower; workspace OOMs are enforced by the pod's
 * memory cgroup and are unaffected.
 */
export const NODE_KUBELET_HOUSEKEEPING_INTERVAL = '300s'
/** kubeadm's kubelet flags file on the kind node, edited by the fixup. */
export const NODE_KUBELET_FLAGS_ENV = '/var/lib/kubelet/kubeadm-flags.env'

/**
 * Run the full preflight suite for the Kubernetes backend. Returns every
 * result, and `ok: false` when any check failed. Roughly in order:
 *
 * - kubectl present and the API server reachable (either failing stops the
 *   run).
 * - nodes: how many can take a workspace, whether all are Ready, and the
 *   `architecture` and `node-os` gates `--byo` installs on.
 * - podman present; the in-cluster registry answering; the namespace.
 * - storage: both claims Bound, `Retain`, and the right backing.
 * - PriorityClasses present.
 * - node-fixups (kind only, warn): kubelet housekeeping and pids limit.
 * - gvisor: RuntimeClasses exist, a node is labeled, and a pod on the class
 *   really is sandboxed. node-tuning (warn): sysctls and TasksMax applied.
 * - Pod probes, run concurrently: the end-to-end probe (registry pull and
 *   the global claim shared with a peer pod), egress enforcement, the npm
 *   cache, per-node readiness on multi-node clusters, nested-mount (warn),
 *   and storage semantics.
 * - datapath: Calico and netd Ready; veth-source: netd's pod-to-veth
 *   mapping resolves on every node.
 * - vap: ValidatingAdmissionPolicy available (builds need it).
 * - runtime-stamp (warn): every workspace pod names a gvisor RuntimeClass.
 *
 * Once a check fails, the pod-based gates that depend on it are skipped.
 */
export async function runClusterCheck(
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const add = (r: CheckResult): void => { results.push(r) }

  try {
    await execFileAsync('kubectl', ['version', '--client', '--output', 'json'])
    add({ name: 'kubectl', status: 'pass', detail: 'installed' })
  } catch {
    add({
      name: 'kubectl', status: 'fail', detail: 'not found on PATH',
      fix: 'Install kubectl: https://kubernetes.io/docs/tasks/tools/',
    })
    return { ok: false, results }
  }

  try {
    await execFileAsync('kubectl', ['version', '--output', 'json'], { timeout: 10_000 })
    add({ name: 'cluster', status: 'pass', detail: 'API server reachable' })
  } catch (err) {
    add({
      name: 'cluster', status: 'fail',
      detail: `API server unreachable (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    })
    return { ok: false, results }
  }

  // Node inventory. Whether a workspace fits on a node depends on the
  // tolerations declared on the gvisor RuntimeClass, which admission
  // merges into every pod naming it. No class (a fresh install) means no
  // tolerations.
  const gvisorScheduling = await gvisorRuntimeClass()
  let nodes: ClusterNode[] = []
  try {
    nodes = await listClusterNodes(gvisorScheduling.tolerations)
    add(nodeInventoryResult(nodes))
  } catch (err) {
    add({ name: 'nodes', status: 'warn', detail: `could not list nodes (${truncate(err)})` })
  }
  // Re-run the `--byo` platform gates, in case a node was added since.
  for (const r of await runNodePlatformChecks()) add(r)

  try {
    await execFileAsync('podman', ['--version'])
    add({ name: 'podman', status: 'pass', detail: 'installed (image build engine)' })
  } catch {
    add({
      name: 'podman', status: 'fail', detail: 'not found on PATH',
      fix: 'Install podman — yaac builds session images with it.',
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
      detail: `cannot create namespace "${k8sNamespace()}" (${truncate(err)})`,
      fix: 'Check your kubeconfig context has admin rights on the cluster.',
    })
  }

  add(await runStorageCheck())
  add(await runPriorityClassCheck())

  const PROBE_GATES = [
    'node-fixups', 'gvisor', 'node-tuning', 'probe', 'egress', 'npm-cache',
    'datapath', 'veth-source',
    ...MULTI_NODE_GATES,
    'nested-mount', 'storage-semantics', 'vap', 'runtime-stamp',
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
  add(await runNodeFixupsCheck())
  add(await runGvisorRuntimeCheck())
  add(await runNodeTuningCheck())

  // The probes run on the gvisor RuntimeClass; without it they would sit
  // Pending until timeout.
  if (results.some((r) => r.status === 'fail')) {
    skipFrom('probe', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  // Probe pods run as the workspace uid/gid recorded on the server
  // Deployment, not this machine's. If it cannot be read, fail here rather
  // than let a wrong-uid probe fail with a misleading message.
  let identity: InstallIdentity
  try {
    identity = await deployedInstallIdentity((await readServerConfig())?.byo === true)
  } catch (err) {
    add({
      name: 'probe', status: 'fail',
      detail: `could not read the install identity off the ${SERVER_APP_NAME} Deployment: `
        + `${kubectlErrorSummary(err)}`,
    })
    skipFrom('egress', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  // The pod probes run concurrently: each starts its own gVisor sandbox,
  // which is slow, and they share no pods or files.
  const [
    probeResult, egressResult, npmCacheResult, nestedMountResult, multiNodeResults, semanticsResult,
  ] = await Promise.all([
    runEndToEndProbe(identity),
    runNetworkPolicyProbe(),
    runNpmCacheProbe(),
    runNestedMountProbe(),
    runMultiNodeReadiness(nodes, gvisorScheduling, identity),
    runStorageSemanticsProbe(identity),
  ])
  add(probeResult)
  add(egressResult)
  add(npmCacheResult)

  add(await runDatapathCheck())
  // netd reports Ready even with no pod-to-veth mappings, so a wrong veth
  // prefix is only caught here.
  add(await runVethSourceCheck())
  // Reported after the datapath, which says whether a node has a redirect
  // at all.
  for (const r of multiNodeResults) add(r)
  add(nestedMountResult)
  add(semanticsResult)
  add(await runVapAvailabilityCheck())
  add(await runRuntimeStampSweep())

  return { ok: !results.some((r) => r.status === 'fail'), results }
}



/**
 * What the readiness gates need to know about one node. `schedulable` means
 * a workspace pod could land here: the node is not cordoned and every taint
 * is tolerated by the gvisor RuntimeClass. `excludedBecause` says why not,
 * so reports can name skipped nodes. `runtimeHandlers` is the kubelet's list
 * of containerd runtimes (Kubernetes 1.30+), empty on older clusters.
 */
interface ClusterNode {
  name: string
  ready: boolean
  schedulable: boolean
  excludedBecause: string
  labels: Record<string, string>
  runtimeHandlers: string[]
}

interface RawNodeItem {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: { unschedulable?: boolean; taints?: NodeTaint[] }
  status?: {
    conditions?: Array<{ type?: string; status?: string }>
    runtimeHandlers?: Array<{ name?: string }>
  }
}

/**
 * Why a workspace cannot land on this node, or '' when one can. Cordoning
 * is reported apart from taints because the fix differs.
 */
function workspaceExclusion(node: RawNodeItem, tolerations: PodToleration[]): string {
  if (node.spec?.unschedulable === true) return 'cordoned'
  const blocking = untoleratedTaints(node.spec?.taints, tolerations)
  if (blocking.length === 0) return ''
  return `untolerated taint ${blocking.map(formatTaint).join(', ')}`
}

async function listClusterNodes(tolerations: PodToleration[]): Promise<ClusterNode[]> {
  const { stdout } = await execFileAsync('kubectl', ['get', 'nodes', '-o', 'json'])
  const items = (JSON.parse(stdout) as { items?: RawNodeItem[] }).items ?? []
  return items.map((n) => {
    const excludedBecause = workspaceExclusion(n, tolerations)
    return {
      name: n.metadata?.name ?? '<unnamed>',
      ready: (n.status?.conditions ?? [])
        .some((c) => c.type === 'Ready' && c.status === 'True'),
      schedulable: excludedBecause === '',
      excludedBecause,
      labels: n.metadata?.labels ?? {},
      runtimeHandlers: (n.status?.runtimeHandlers ?? [])
        .map((h) => h.name ?? '')
        .filter(Boolean),
    }
  })
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
  + 'sessions pool — declare the pool\'s toleration on the RuntimeClass so '
  + 'every sandboxed pod inherits it, rather than removing the taint that '
  + 'keeps other workloads off the pool. Key that toleration to the pool\'s '
  + 'own taint: a bare `{operator: Exists}` tolerates everything, so every '
  + 'node reads eligible whatever it is carrying.'

/**
 * The node inventory result. Warns on NotReady nodes or when no node can
 * take a workspace; node count alone is fine (`--nodes N` is supported).
 */
function nodeInventoryResult(nodes: ClusterNode[]): CheckResult {
  if (nodes.length === 0) {
    return { name: 'nodes', status: 'warn', detail: 'the cluster reports no nodes' }
  }
  const notReady = nodes.filter((n) => !n.ready).map((n) => n.name)
  if (notReady.length > 0) {
    return {
      name: 'nodes', status: 'warn',
      detail: `${nodes.length} node(s), NotReady: ${notReady.join(', ')}`,
      fix: 'A NotReady node runs nothing. Check the CNI on it '
        + '(`kubectl -n kube-system get pods -o wide -l k8s-app=calico-node`).',
    }
  }
  const eligible = nodes.filter((n) => n.schedulable)
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
  'These are settings of the kind node CONTAINER (podman state, not node '
  + 'state), which a cluster recreate drops. Re-apply them with: yaac cluster install'

/**
 * Warn if the kind-only node fixups `yaac cluster install` applies through
 * podman are missing: the kubelet housekeeping interval and the node
 * container's pids limit. Their absence shows up late (kubelet CPU burn,
 * workspaces dying under subagent fan-out). Skips byo installs and nodes
 * that are not podman containers.
 */
async function runNodeFixupsCheck(): Promise<CheckResult> {
  // Checked explicitly: a byo install on kind also has podman node
  // containers, but their settings are not yaac's to manage.
  if ((await readServerConfig())?.byo) {
    return {
      name: 'node-fixups', status: 'skip',
      detail: 'a byo install — the kubelet and pids settings are the node pool\'s, not yaac\'s',
    }
  }
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    const nodes = stdout.trim().split(/\s+/).filter(Boolean)
    if (nodes.length === 0) {
      return { name: 'node-fixups', status: 'warn', detail: 'no nodes found — fixups unverified' }
    }
    const missing = new Set<string>()
    for (const node of nodes) {
      let report: string
      try {
        const res = await execFileAsync('podman', ['exec', node, 'sh', '-c',
          `grep -q -- '--housekeeping-interval=${NODE_KUBELET_HOUSEKEEPING_INTERVAL}' `
          + `${NODE_KUBELET_FLAGS_ENV} && echo hk=ok || echo hk=missing`,
        ])
        report = res.stdout
      } catch {
        return {
          name: 'node-fixups', status: 'skip',
          detail: `node "${node}" is not a podman container — kind node fixups not applicable`,
        }
      }
      if (report.includes('hk=missing')) {
        missing.add('kubelet housekeeping-interval (cAdvisor stats CPU)')
      }
      const { stdout: pidsRaw } = await execFileAsync('podman', [
        'inspect', '--format', '{{.HostConfig.PidsLimit}}', node,
      ])
      const pids = Number(pidsRaw.trim())
      if (Number.isFinite(pids) && pids > 0 && pids < NODE_PIDS_LIMIT) {
        missing.add('node pids-limit (subagent fan-out)')
      }
    }
    if (missing.size > 0) {
      return {
        name: 'node-fixups', status: 'warn',
        detail: `missing on the node: ${[...missing].join(', ')}`,
        fix: NODE_FIXUPS_FIX,
      }
    }
    return {
      name: 'node-fixups', status: 'pass',
      detail: 'kubelet housekeeping and pids-limit in place',
    }
  } catch (err) {
    return {
      name: 'node-fixups', status: 'warn',
      detail: `could not verify node fixups (${truncate(err)})`,
      fix: NODE_FIXUPS_FIX,
    }
  }
}

const STORAGE_FIX =
  'The two storage claims are applied by `yaac cluster install`: on kind, '
  + 'static hostPath volumes into the data dir\'s `global/` and `server-local/` '
  + 'folders; on a byo install, volumes provisioned from the named classes, '
  + 'pinned `Retain`, labelled, and (the RWX one) mounted with `actimeo=1`. '
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
    csi?: { driver?: string; volumeAttributes?: Record<string, string> }
    storageClassName?: string
    mountOptions?: string[]
  }
}

/**
 * The storage gate (fail-level; the server pod and the probes mount the
 * global claim). Both claims must be Bound with `Retain` volumes, so
 * deleting a claim or namespace never deletes data. Then, by volume class:
 *
 * - No class (kind's static volumes): a hostPath into this data dir's own
 *   tier folder. (Checked by class, not source, because local-path also
 *   provisions hostPath volumes.)
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
  }
  try {
    // An e2e file's server records none; it is matched by its data dir.
    const installId = (await readServerConfig())?.installId
    const problems: string[] = []
    const bound: string[] = []
    for (const name of [GLOBAL_CLAIM_NAME, SERVER_LOCAL_CLAIM_NAME]) {
      const pvc = await kubectlGetJson<RawPvcRead>(['get', 'pvc', name, '-n', ns])
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
      const pv = await kubectlGetJson<RawPvRead>(['get', 'pv', volumeName])
      const reclaim = pv?.spec?.persistentVolumeReclaimPolicy
      if (reclaim !== 'Retain') {
        problems.push(`${name}: volume ${volumeName} reclaims by ${reclaim ?? 'an unknown policy'}, not Retain`)
      }
      if (!pv?.spec?.storageClassName) {
        const hostPath = pv?.spec?.hostPath?.path
        if (hostPath !== expectedHostPath[name]) {
          problems.push(`${name}: volume ${volumeName} is ${hostPath ?? 'not a hostPath volume'}, `
            + `not ${expectedHostPath[name]}`)
        }
        bound.push(`${name} → ${volumeName} (${hostPath ?? '?'})`)
        continue
      }
      const labels = pv.metadata?.labels ?? {}
      const ours = installId !== undefined
        ? labels[LABEL_INSTALL_ID] === installId
        : labels[LABEL_DATA_DIR_HASH] === dataDirHash()
      if (!ours || labels[LABEL_CLAIM] !== name) {
        problems.push(`${name}: volume ${volumeName} does not carry this install's labels, so a `
          + 're-install could not find it again')
      }
      if (name === GLOBAL_CLAIM_NAME) problems.push(...await sharedVolumeProblems(volumeName, pv))
      bound.push(`${name} → ${volumeName} (${pv.spec.storageClassName})`)
    }
    if (problems.length > 0) {
      return { name: 'storage', status: 'fail', detail: problems.join('; '), fix: STORAGE_FIX }
    }
    return { name: 'storage', status: 'pass', detail: `${bound.join('; ')}, both Bound and Retain` }
  } catch (err) {
    return {
      name: 'storage', status: 'fail',
      detail: `could not read the storage claims (${truncate(err)})`,
      fix: STORAGE_FIX,
    }
  }
}

/** What a provisioned global volume must be, beyond Bound and Retain. */
async function sharedVolumeProblems(volumeName: string, pv: RawPvRead | null): Promise<string[]> {
  const problems: string[] = []
  const className = pv?.spec?.storageClassName ?? ''
  const sc = className
    ? await kubectlGetJson<{ provisioner?: string; parameters?: Record<string, string> }>([
      'get', 'storageclass', className,
    ])
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
async function runNodePlatformChecks(): Promise<CheckResult[]> {
  let nodes: PlatformNode[]
  try {
    const { stdout } = await execFileAsync('kubectl', ['get', 'nodes', '-o', 'json'])
    nodes = (JSON.parse(stdout) as { items?: PlatformNode[] }).items ?? []
  } catch (err) {
    return ['architecture', 'node-os'].map((name) => ({
      name, status: 'warn' as const, detail: `could not read the nodes (${truncate(err)})`,
    }))
  }
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

function nodeTuningFix(): string {
  return 'The gVisor installer DaemonSet applies these on every pass (on every node '
    + 'it lands on, and every ten minutes), so a node that just restarted reads '
    + 'as tuned once its first pass lands. If it stays this way, read the '
    + `installer's log: kubectl -n ${k8sNamespace()} logs -l app=${GVISOR_INSTALLER_APP_NAME}\n`
    + 'Re-apply the DaemonSet with: yaac cluster install'
}

/**
 * Warn-level check that the installer DaemonSet's node tuning is in place
 * (the sysctls and systemd's live DefaultTasksMax; node-tuning.ts). Reads
 * them via `kubectl exec` into the installer pod on each node, so it works
 * without node shell access. A sysctl the kernel lacks is skipped. Nodes
 * whose installer pod is missing, not Running, or cannot be exec'd count
 * as unverified, never as passing.
 */
async function runNodeTuningCheck(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'pods', '-n', ns, '-l', `app=${GVISOR_INSTALLER_APP_NAME}`, '-o', 'json',
    ])
    const pods = ((JSON.parse(stdout) as {
      items?: Array<{
        metadata?: { name?: string }
        spec?: { nodeName?: string }
        status?: { phase?: string }
      }>
    }).items ?? []).filter((p) => p.metadata?.name)
    const { stdout: desiredRaw } = await execFileAsync('kubectl', [
      'get', 'daemonset', GVISOR_INSTALLER_APP_NAME, '-n', ns,
      '-o', 'jsonpath={.status.desiredNumberScheduled}',
    ])
    const desired = Number(desiredRaw.trim() || '0')
    const probe = NODE_TUNING_SYSCTLS
      .map((t) => `echo ${t.path}=$(cat /proc/sys/${t.path} 2>/dev/null || echo absent)`)
      .concat('echo tasksmax=$(nsenter -t 1 -m -- systemctl show -p DefaultTasksMax --value 2>/dev/null)')
      .join('; ')
    const missing: string[] = []
    const unverified: string[] = []
    if (pods.length < desired) unverified.push(`${desired - pods.length} node(s) with no installer pod`)
    let verified = 0
    for (const pod of pods) {
      const node = pod.spec?.nodeName ?? '<unscheduled>'
      if (pod.status?.phase !== 'Running') {
        unverified.push(`${node} (${pod.status?.phase ?? 'no phase'})`)
        continue
      }
      let report: string
      try {
        ({ stdout: report } = await execFileAsync('kubectl', [
          'exec', pod.metadata!.name!, '-n', ns, '-c', 'install', '--', 'sh', '-c', probe,
        ], { timeout: 60_000 }))
      } catch (err) {
        unverified.push(`${node} (${truncate(err)})`)
        continue
      }
      verified += 1
      const wrong: string[] = []
      for (const t of NODE_TUNING_SYSCTLS) {
        const raw = new RegExp(`^${t.path}=(\\S*)$`, 'm').exec(report)?.[1] ?? ''
        if (raw === 'absent') continue
        const live = Number(raw || Number.NaN)
        const ok = t.mode === 'raise' ? live >= t.value : live === t.value
        if (!ok) {
          wrong.push(`${t.path.replaceAll('/', '.')}=${Number.isNaN(live) ? '?' : String(live)} (${t.why})`)
        }
      }
      const tasksMax = /^tasksmax=(.*)$/m.exec(report)?.[1] ?? ''
      if (tasksMax !== NODE_TASKSMAX_LIVE) {
        wrong.push(`DefaultTasksMax=${tasksMax || '?'} (subagent fan-out)`)
      }
      if (wrong.length > 0) missing.push(`${node}: ${wrong.join(', ')}`)
    }
    if (missing.length > 0) {
      return {
        name: 'node-tuning', status: 'warn',
        detail: `not in place on ${missing.join('; ')}`
          + (unverified.length > 0 ? `; unverified on ${unverified.join(', ')}` : ''),
        fix: nodeTuningFix(),
      }
    }
    if (unverified.length > 0) {
      return {
        name: 'node-tuning', status: 'warn',
        detail: `in place on ${verified} node(s); unverified on ${unverified.join(', ')}`,
        fix: nodeTuningFix(),
      }
    }
    return {
      name: 'node-tuning', status: 'pass',
      detail: `sysctls and DefaultTasksMax in place on ${verified} node(s)`,
    }
  } catch (err) {
    return {
      name: 'node-tuning', status: 'warn',
      detail: `could not verify node tuning (${truncate(err)})`,
      fix: nodeTuningFix(),
    }
  }
}

/**
 * Once the registry answers, check that anonymous writes are refused;
 * otherwise any builder pod could overwrite trusted images. The probe
 * upload is only started, never finished; an open registry purges the
 * empty session itself.
 */
async function registryGateResult(): Promise<CheckResult> {
  let status: number | null = null
  try {
    const res = await fetch(`http://${await registryEndpoint()}/v2/yaac-cluster-probe/blobs/uploads/`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    })
    status = res.status
  } catch { /* reported below */ }
  if (status === 401) {
    return { name: 'registry', status: 'pass', detail: `serving as ${registryHost()}; writes need a grant` }
  }
  if (status !== null && status >= 200 && status < 300) {
    return {
      name: 'registry', status: 'fail',
      detail: `the in-cluster registry ${registryHost()} accepts anonymous writes — its write gate is missing`,
      fix: 'An install that predates the gate rolled it. Re-apply it with:\n  yaac cluster install',
    }
  }
  return {
    name: 'registry', status: 'warn',
    detail: `serving as ${registryHost()}, but its write gate could not be verified `
      + `(${status === null ? 'no answer' : `HTTP ${String(status)}`} to an anonymous upload)`,
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

const GVISOR_PROBE_POD_NAME = 'yaac-cluster-check-gvisor'

/** A function because the namespace must not be read at import time. */
function gvisorFix(): string {
  return 'Install the gVisor runtime with: yaac cluster install\n'
    + '(applies the yaac-gvisor-install DaemonSet, which drops pinned runsc + '
    + 'containerd-shim-runsc-v1 on every node, registers the runsc handlers in '
    + 'its containerd and labels it, plus the gvisor/gvisor-nested '
    + 'RuntimeClasses that schedule on that label)\n'
    + `Inspect it with: kubectl -n ${k8sNamespace()} logs -l app=yaac-gvisor-install`
}

const PRIORITY_CLASS_FIX =
  'Install the yaac PriorityClasses with: yaac cluster install\n'
  + '(the yaac server also re-applies them on every start)'

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
    const { stdout } = await execFileAsync('kubectl', ['get', 'priorityclass', '-o', 'json'])
    const live = new Map((JSON.parse(stdout) as {
      items: Array<{ metadata?: { name?: string }; value?: number; preemptionPolicy?: string }>
    }).items.map((c) => [c.metadata?.name ?? '', c]))

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
      detail: `could not read PriorityClasses (${truncate(err)})`,
      fix: PRIORITY_CLASS_FIX,
    }
  }
}

/**
 * The gVisor gate. Workspace pods rely on gVisor for isolation, so a
 * missing RuntimeClass, or a handler that silently runs runc, is unsafe.
 * Checks that:
 *
 * 1. both RuntimeClasses exist;
 * 2. at least one node has the installer's label (otherwise the probe pod
 *    would just sit Pending with a misleading error);
 * 3. a pod on the gvisor class is really sandboxed: gVisor's dmesg shows
 *    its own boot messages, while runc shows the node kernel's.
 */
async function runGvisorRuntimeCheck(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'runtimeclass', '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    const present = new Set(stdout.trim().split(/\s+/).filter(Boolean))
    const missing = [RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED]
      .filter((n) => !present.has(n))
    if (missing.length > 0) {
      return {
        name: 'gvisor', status: 'fail',
        detail: `missing RuntimeClass(es): ${missing.join(', ')}`,
        fix: gvisorFix(),
      }
    }

    const { stdout: labelled } = await execFileAsync('kubectl', [
      'get', 'nodes', '-l', `${GVISOR_NODE_LABEL}=true`,
      '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    if (labelled.trim() === '') {
      return {
        name: 'gvisor', status: 'fail',
        detail: `no node carries the ${GVISOR_NODE_LABEL} label — the installer `
          + 'DaemonSet has not converged on any node (a cluster set up by an older '
          + 'yaac reads this way until it is applied)',
        fix: gvisorFix(),
      }
    }

    const imageRef = await ensureProbeImage()
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: GVISOR_PROBE_POD_NAME, namespace: k8sNamespace() },
      spec: {
        restartPolicy: 'Never',
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        containers: [{
          name: 'probe',
          image: imageRef,
          command: [
            'sh', '-c',
            'dmesg 2>/dev/null | grep -qi gvisor'
            + ' && echo GVISOR_SANDBOXED || echo GVISOR_NOT_SANDBOXED',
          ],
        }],
      },
    }, {
      timeoutMs: 90_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
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
      detail: 'RuntimeClasses present; gvisor pods run inside the sentry',
    }
  } catch (err) {
    return {
      name: 'gvisor', status: 'fail',
      detail: `gvisor probe errored (${truncate(err)})`,
      fix: gvisorFix(),
    }
  }
}

/**
 * Warn when a workspace pod (by its `yaac.workspace-id` label) does not
 * name a gvisor RuntimeClass. Trusted infra pods run on runc and are not
 * checked.
 */
async function runRuntimeStampSweep(): Promise<CheckResult> {
  const ns = k8sNamespace()
  const sandboxed = new Set<string>([RUNTIME_CLASS_GVISOR, RUNTIME_CLASS_GVISOR_NESTED])
  try {
    const { stdout } = await execFileAsync('kubectl', ['get', 'pods', '-A', '-o', 'json'])
    const items = (JSON.parse(stdout) as {
      items: Array<{
        metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
        spec?: { runtimeClassName?: string }
      }>
    }).items
    const strays = items
      .filter((p) => p.metadata?.namespace === ns
        && !!p.metadata.labels && LABEL_WORKSPACE_ID in p.metadata.labels
        && !sandboxed.has(p.spec?.runtimeClassName ?? ''))
      .map((p) => `${p.metadata?.namespace ?? '?'}/${p.metadata?.name ?? '<unnamed>'}`)
    if (strays.length > 0) {
      const shown = strays.slice(0, 5).join(', ')
      return {
        name: 'runtime-stamp', status: 'warn',
        detail: `untrusted pod(s) without a gvisor-tier runtimeClassName: ${shown}`
          + (strays.length > 5 ? ` (+${strays.length - 5} more)` : ''),
        fix: 'These pods predate the gVisor migration (or bypassed the yaac '
          + 'builders). They keep running unsandboxed on the default '
          + 'runtime; recreate old sessions to converge.',
      }
    }
    return {
      name: 'runtime-stamp', status: 'pass',
      detail: `every untrusted pod in "${ns}" is gvisor-sandboxed`,
    }
  } catch (err) {
    return {
      name: 'runtime-stamp', status: 'warn',
      detail: `could not sweep pods (${truncate(err)})`,
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
 * A peer pod that plays the server's role for a probe: runc, at the install
 * identity, with `yaac-global` mounted whole. It exchanges nonces with the
 * probe pod through the claim.
 *
 * `pair` labels it and prefers a different node from any pod with the
 * same label, so on a multi-node cluster the exchange crosses nodes. Its
 * node name is in the environment for reporting.
 */
function buildPeerPodManifest(opts: {
  name: string
  imageRef: string
  identity: InstallIdentity
  pair: string
  script: string
  args: string[]
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: opts.name, namespace: k8sNamespace(), labels: pairLabels(opts.pair) },
    spec: {
      restartPolicy: 'Never',
      // Bounds a peer left Pending by an aborted check.
      activeDeadlineSeconds: 300,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      affinity: pairAntiAffinity(opts.pair),
      securityContext: {
        seccompProfile: { type: 'RuntimeDefault' },
        ...installSecurityContext(opts.identity),
      },
      containers: [{
        name: 'peer',
        image: opts.imageRef,
        securityContext: { allowPrivilegeEscalation: false },
        command: ['sh', '-c', opts.script, '--', ...opts.args],
        env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } }],
        volumeMounts: [{ name: 'global', mountPath: '/probe' }],
      }],
      volumes: [{ name: 'global', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }],
    },
  }
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
  await execFileAsync('kubectl', [
    'delete', 'pod', name, '-n', k8sNamespace(), '--ignore-not-found', '--wait=false',
  ]).catch(() => { /* its own run deletes it anyway */ })
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
 * The probe's half: wait for the peer's nonce, print it, write a marker for
 * the peer, signal the beacon, and acknowledge the second nonce. It runs at
 * the workspace uid under gVisor, like workspace setup.
 */
const PROBE_SCRIPT = [
  'd="/probe/$1"',
  'echo "PROBE_NODE=$NODE_NAME"',
  'i=0; while [ $i -lt 3000 ] && [ ! -f "$d/nonce" ]; do sleep 0.02; i=$((i+1)); done',
  'echo "PROBE_READ=$(cat "$d/nonce" 2>/dev/null)"',
  '[ -f "$d/nonce" ] || exit 0',
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
  const ns = k8sNamespace()
  const { runAsUser } = installSecurityContext(identity)
  try {
    const imageRef = await ensureProbeImage()

    const manifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: PROBE_POD_NAME, namespace: ns, labels: pairLabels('probe') },
      spec: {
        restartPolicy: 'Never',
        affinity: pairAntiAffinity('probe'),
        // Same runtime and uid as a workspace pod (buildPodJobManifest).
        ...runtimeClassSpec(),
        securityContext: {
          seccompProfile: { type: 'RuntimeDefault' },
          ...installSecurityContext(identity),
        },
        containers: [{
          name: 'probe',
          image: imageRef,
          command: ['sh', '-c', PROBE_SCRIPT, '--', dir],
          env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } }],
          volumeMounts: [{ name: 'probe', mountPath: '/probe' }],
        }],
        volumes: [{ name: 'probe', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }],
      },
    }
    const runOpts = {
      pollMs: 250,
      kubectl: (args: string[]) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    }
    // The peer runs alongside and is deleted early if the probe fails.
    const probeRun = runPodToCompletion(manifest, { ...runOpts, timeoutMs: 90_000 })
    const peerRun = runPodToCompletion(buildPeerPodManifest({
      name: PEER_POD_NAME, imageRef, identity, pair: 'probe',
      script: PEER_PROBE_SCRIPT, args: [dir, nonce],
    }), { ...runOpts, timeoutMs: 150_000 })
    void probeRun.then(async (r) => {
      if (r.phase !== 'Succeeded') await releasePeer(PEER_POD_NAME)
    }, () => { /* reported below */ })
    const [{ phase, logs }, peer] = await Promise.all([probeRun, peerRun])
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
          + 'node needs the home extraMount to see; `yaac cluster install` '
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
      detail: `probe errored (${truncate(err)})`,
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
  // NFS before 4.2 (e.g. EFS, Azure Files) has no xattrs. The only user.*
  // xattr yaac writes (image-store overlay markers) is on the node-local
  // tier.
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
 * temporary ConfigMap, run in the builder image because it has python3).
 * Fail-level on every backend; a probe that cannot run also fails.
 */
async function runStorageSemanticsProbe(identity: InstallIdentity): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const script = await fs.readFile(path.join(PACKAGE_ROOT, 'k8s', 'probes', 'fsprobe.py'), 'utf8')
    await kubectlApply({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: FSPROBE_CONFIGMAP_NAME, namespace: ns },
      data: { 'fsprobe.py': script },
    })
    const imageRef = await ensureBuilderImage()
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: FSPROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...runtimeClassSpec(),
        securityContext: { seccompProfile: { type: 'RuntimeDefault' }, ...installSecurityContext(identity) },
        containers: [{
          name: 'probe',
          image: imageRef,
          imagePullPolicy: 'IfNotPresent',
          // fsprobe leaves its scratch dir behind.
          command: ['sh', '-c', 'python3 /probes/fsprobe.py /probe; rc=$?; rm -rf /probe/fsprobe-*; exit $rc'],
          volumeMounts: [
            { name: 'probe', mountPath: '/probe' },
            { name: 'script', mountPath: '/probes', readOnly: true },
          ],
        }],
        volumes: [
          { name: 'probe', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } },
          { name: 'script', configMap: { name: FSPROBE_CONFIGMAP_NAME } },
        ],
      },
    }, {
      timeoutMs: 120_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
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
      detail: `fsprobe errored (${truncate(err)})`,
      fix: STORAGE_SEMANTICS_FIX,
    }
  } finally {
    await kubectlWithRetry([
      'delete', 'configmap', FSPROBE_CONFIGMAP_NAME, '-n', ns, '--ignore-not-found',
    ], { maxAttempts: 1 }).catch(() => { /* best-effort */ })
  }
}

/** The readiness gates the multi-node sweep reports, in order. */
const MULTI_NODE_GATES = ['runsc-nodes', 'registry-nodes', 'volume-nodes'] as const

const NODE_PROBE_POD_PREFIX = 'yaac-cluster-check-node'
const SWEEP_PEER_POD_NAME = 'yaac-cluster-check-sweep-peer'
/** Distinct from the end-to-end probe's prefix, which runs concurrently
 *  and clears its own. */
const SWEEP_DIR_PREFIX = '.cluster-check-nodes-'

/**
 * The sweep's peer (see buildPeerPodManifest): publish the nonce, wait
 * until every node's probe left its marker or the check writes `done`
 * (so a node whose pod never ran does not hold it up), then report the
 * markers it saw and clean up.
 */
const SWEEP_PEER_SCRIPT = [
  `rm -rf /probe/${SWEEP_DIR_PREFIX}*`,
  'd="/probe/$1"; n=$3',
  'mkdir "$d" && printf %s "$2" > "$d/nonce.tmp" && mv "$d/nonce.tmp" "$d/nonce"',
  'i=0',
  'while [ $i -lt 1400 ] && [ ! -f "$d/done" ]; do',
  '  seen=0; k=0; while [ $k -lt $n ]; do [ -f "$d/node-$k" ] && seen=$((seen+1)); k=$((k+1)); done',
  '  [ $seen -eq $n ] && break',
  '  sleep 0.05; i=$((i+1))',
  'done',
  'k=0; while [ $k -lt $n ]; do',
  '  [ "$(cat "$d/node-$k" 2>/dev/null)" = ok ] && echo "PEER_MARKER=$k"',
  '  k=$((k+1))',
  'done',
  'rm -rf "$d"',
].join('\n')

/**
 * Which gate a probe pod that never ran is blamed on, read from the
 * kubelet's event (the pod phase alone cannot tell). `unknown` shows up as
 * unverified on every gate rather than passing any of them.
 */
type ProbeBlame = 'registry' | 'volume' | 'runsc' | 'unknown'

interface NodeProbeOutcome {
  node: string
  /** Terminal phase of the pinned probe pod ('Pending' when it never ran). */
  phase: string
  /** The gVisor fingerprint appeared in dmesg. Informational only: the
   *  workspace uid may not be able to read dmesg. */
  sandboxed: boolean
  sawNonce: boolean
  wroteMarker: boolean
  /** Set when the pod did not succeed: which gate its failure belongs to. */
  blame: ProbeBlame
  /** The kubelet event the blame was read from, for the warn detail. */
  failureHint: string
}

/**
 * The live gvisor RuntimeClass. Admission merges its `scheduling` into
 * every pod naming it, so this is what decides where sandboxed pods go:
 *
 *  - `handler`: the containerd handler it names.
 *  - `nodeSelector`: the label the gVisor installer puts on nodes it has
 *    set up. A node outside it is reported under runsc-nodes.
 *  - `tolerations`: what sandboxed pods tolerate, e.g. a tainted workspace
 *    pool. Empty locally, and when the class is missing.
 */
interface GvisorScheduling {
  handler: string
  nodeSelector: Record<string, string>
  tolerations: PodToleration[]
}

async function gvisorRuntimeClass(): Promise<GvisorScheduling> {
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'runtimeclass', RUNTIME_CLASS_GVISOR, '-o', 'json',
    ])
    const rc = JSON.parse(stdout) as {
      handler?: string
      scheduling?: { nodeSelector?: Record<string, string>; tolerations?: PodToleration[] }
    }
    return {
      handler: rc.handler ?? '',
      nodeSelector: rc.scheduling?.nodeSelector ?? {},
      tolerations: rc.scheduling?.tolerations ?? [],
    }
  } catch {
    return { handler: '', nodeSelector: {}, tolerations: [] }
  }
}

/**
 * The pod's most recent Warning event, as `reason: message`. Events outlive
 * the pod, so this works after runPodToCompletion deletes it, and it covers
 * mount failures, which leave no containerStatuses.
 */
async function podFailureEvent(podName: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'events', '-n', k8sNamespace(),
      '--field-selector', `involvedObject.name=${podName}`, '-o', 'json',
    ])
    const items = (JSON.parse(stdout) as {
      items?: Array<{ type?: string; reason?: string; message?: string }>
    }).items ?? []
    const warning = items.filter((e) => e.type === 'Warning').pop()
    if (!warning) return ''
    return `${warning.reason ?? 'Warning'}: ${(warning.message ?? '').trim()}`
  } catch {
    return ''
  }
}

/**
 * Blame a probe pod that never ran on the gate whose fix applies. Mounts
 * are checked first because kubelet mounts volumes before pulling. The bare
 * word "sandbox" is not matched: `FailedCreatePodSandBox` also covers CNI
 * failures. Anything unrecognized is `unknown`.
 */
function blameProbeFailure(event: string): ProbeBlame {
  if (/FailedMount|MountVolume|hostPath|FailedAttachVolume|PersistentVolumeClaim|not bound/i.test(event)) return 'volume'
  if (/RuntimeClass|runsc|no runtime for/i.test(event)) return 'runsc'
  if (/ImagePull|ErrImage|pull|manifest unknown|no such host|connection refused/i.test(event)) {
    return 'registry'
  }
  return 'unknown'
}

/**
 * One probe pod pinned to one node, doing what a workspace needs from that
 * node: pull from the registry (`Always`, so a cached image cannot hide a
 * broken registry), run on the gvisor RuntimeClass, and read and write the
 * global claim at the workspace uid.
 *
 * `nodeName` bypasses the scheduler so the answer is about this node. The
 * pod gets the RuntimeClass's tolerations and declares none of its own, so
 * it tolerates exactly what a workspace pod does.
 */
async function probeNode(
  node: ClusterNode,
  index: number,
  ctx: { imageRef: string; nonce: string; dir: string; identity: InstallIdentity },
): Promise<NodeProbeOutcome> {
  const marker = `node-${String(index)}`
  const podName = `${NODE_PROBE_POD_PREFIX}-${index}`
  const outcome: NodeProbeOutcome = {
    node: node.name, phase: 'Pending', sandboxed: false, sawNonce: false, wroteMarker: false,
    blame: 'unknown', failureHint: '',
  }
  try {
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: podName, namespace: k8sNamespace() },
      spec: {
        nodeName: node.name,
        restartPolicy: 'Never',
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        securityContext: {
          seccompProfile: { type: 'RuntimeDefault' },
          ...installSecurityContext(ctx.identity),
        },
        containers: [{
          name: 'probe',
          image: ctx.imageRef,
          imagePullPolicy: 'Always',
          command: [
            'sh', '-c',
            'dmesg 2>/dev/null | grep -qi gvisor && echo GVISOR_SANDBOXED; '
            + 'i=0; while [ $i -lt 2000 ] && [ ! -f "$1/nonce" ]; do sleep 0.02; i=$((i+1)); done; '
            + `cat "$1/nonce" && echo ok > "$1/${marker}"`,
            '--', `/probe/${ctx.dir}`,
          ],
          volumeMounts: [{ name: 'probe', mountPath: '/probe' }],
        }],
        volumes: [{ name: 'probe', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } }],
      },
    }, {
      // A pinned pod not done within a minute is stuck, not slow.
      timeoutMs: 60_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    outcome.phase = phase
    outcome.sandboxed = logs.includes('GVISOR_SANDBOXED')
    outcome.sawNonce = logs.includes(ctx.nonce)
    if (phase !== 'Succeeded') {
      outcome.failureHint = await podFailureEvent(podName)
      outcome.blame = blameProbeFailure(outcome.failureHint)
    }
    return outcome
  } catch {
    return outcome
  }
}

const REGISTRY_NODES_FIX =
  'Each node pulls session images itself, so every node needs the registry '
  + 'wiring: the containerd `hosts.toml` mapping and the registry container '
  + 'on the kind network. `yaac cluster install` re-applies both on '
  + 'every node.'

const VOLUME_NODES_FIX =
  `Session pods mount subPaths of the ${GLOBAL_CLAIM_NAME} claim, whose volume `
  + 'on kind is a hostPath into the data dir that resolves on the NODE. Every '
  + 'node therefore needs the home-directory extraMount — `yaac cluster '
  + 'install --nodes N` renders it onto every node it creates, so a cluster '
  + 'made by hand (or by an older yaac) is the usual cause. On a cloud '
  + 'cluster the volume itself has to attach on every node.'

/** Node names for a warn detail, capped so a wide cluster stays readable. */
function nodeList(names: string[]): string {
  return names.slice(0, 4).join(', ') + (names.length > 4 ? ` (+${names.length - 4} more)` : '')
}

/**
 * Multi-node readiness (warn-level; skipped on a single node, which the
 * other gates already cover). For each node a workspace could land on:
 *
 *  - **runsc-nodes**: the gvisor runtime is there. Judged by the
 *    installer's node label, then the kubelet's `status.runtimeHandlers`
 *    if published, then the probe pod's outcome.
 *  - **registry-nodes**: the node's containerd can pull from the registry.
 *  - **volume-nodes**: the node sees the same global claim as the server,
 *    and the workspace uid can write it.
 *
 * A probe pod that never ran is blamed on one gate (blameProbeFailure) and
 * shown as unverified on the others. Every detail also names the nodes the
 * sweep skipped and why.
 */
async function runMultiNodeReadiness(
  nodes: ClusterNode[],
  gvisorScheduling: GvisorScheduling,
  identity: InstallIdentity,
): Promise<CheckResult[]> {
  const uniform = (status: CheckResult['status'], detail: string, fix?: string): CheckResult[] =>
    MULTI_NODE_GATES.map((name) => ({ name, status, detail, ...(fix ? { fix } : {}) }))

  if (nodes.length === 0) {
    return uniform('warn', 'node list unavailable — per-node readiness unverified')
  }
  if (nodes.length === 1) {
    return uniform('skip', 'skipped — single-node cluster (the gvisor and probe gates cover it)')
  }

  const { handler, nodeSelector } = gvisorScheduling

  // `workspaceCapable`: Ready, uncordoned, taints tolerated. `eligible`:
  // also matches the RuntimeClass nodeSelector, so a sandboxed pod can be
  // scheduled there today. Capable but unlabelled nodes are nodes the
  // runtime has not reached yet, reported under runsc-nodes.
  const workspaceCapable = nodes.filter((n) => n.ready && n.schedulable)
  const eligible = workspaceCapable.filter((n) =>
    Object.entries(nodeSelector).every(([k, v]) => n.labels[k] === v))
  const unlabelled = workspaceCapable.filter((n) => !eligible.includes(n))

  // Nodes the sweep skips, named in every gate's detail.
  const skipped = [
    ...nodes.filter((n) => !n.ready).map((n) => `${n.name} (NotReady)`),
    ...nodes.filter((n) => n.ready && !n.schedulable)
      .map((n) => `${n.name} (${n.excludedBecause})`),
  ]
  const skippedTail = skipped.length > 0
    ? `; not swept: ${nodeList(skipped)}`
    : ''

  if (workspaceCapable.length === 0) {
    return uniform(
      'warn',
      `no node can schedule a session (see the nodes check above): ${nodeList(skipped)}`,
    )
  }
  if (eligible.length === 0) {
    return uniform(
      'warn',
      `no session-capable node satisfies the ${RUNTIME_CLASS_GVISOR} RuntimeClass `
      + `nodeSelector, so nothing can be probed: ${nodeList(workspaceCapable.map((n) => n.name))}`
      + skippedTail,
      gvisorFix(),
    )
  }

  const nonce = crypto.randomUUID()
  const dir = `${SWEEP_DIR_PREFIX}${nonce}`
  try {
    const imageRef = await ensureProbeImage()
    // Each node's write must reach the peer, which plays the server. It is
    // told when the node probes finish, so a stuck node does not hold it.
    const peerRun = runPodToCompletion(buildPeerPodManifest({
      name: SWEEP_PEER_POD_NAME, imageRef, identity, pair: 'sweep',
      script: SWEEP_PEER_SCRIPT, args: [dir, nonce, String(eligible.length)],
    }), {
      timeoutMs: 120_000,
      pollMs: 250,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    const outcomes = await Promise.all(eligible.map((node, i) =>
      probeNode(node, i, { imageRef, nonce, dir, identity })))
    await execFileAsync('kubectl', [
      'exec', SWEEP_PEER_POD_NAME, '-n', k8sNamespace(), '--', 'touch', `/probe/${dir}/done`,
    ]).catch(() => { /* it already finished, or it never ran — its logs say which */ })
    const peer = await peerRun
    const markers = new Set(peer.logs.split('\n')
      .map((l) => /^PEER_MARKER=(\d+)$/.exec(l.trim())?.[1])
      .filter((m): m is string => m !== undefined))
    outcomes.forEach((o, i) => { o.wroteMarker = markers.has(String(i)) })

    const ran = new Map(outcomes.map((o) => [o.node, o]))
    const failed = outcomes.filter((o) => o.phase !== 'Succeeded')
    const withCause = (o: NodeProbeOutcome): string =>
      `${o.node} (${o.failureHint || o.phase})`

    // Decided per node: a kubelet that publishes runtimeHandlers is judged
    // by them, otherwise by the node's probe pod.
    const runscVerdict = (n: ClusterNode): 'ok' | 'missing' | 'unknown' => {
      if (handler !== '' && n.runtimeHandlers.length > 0) {
        return n.runtimeHandlers.includes(handler) ? 'ok' : 'missing'
      }
      const o = ran.get(n.name)
      if (o?.phase === 'Succeeded') return 'ok'
      return o?.blame === 'runsc' ? 'missing' : 'unknown'
    }

    const sentryVerified = outcomes.filter((o) => o.sandboxed).length
    const probeUid = identity.uid
    const gate = (
      name: (typeof MULTI_NODE_GATES)[number],
      broken: string[],
      unverified: string[],
      fix: string,
      brokenDetail: (list: string) => string,
      passDetail: string,
    ): CheckResult => {
      const unverifiedTail = unverified.length > 0
        ? `; unverified on ${nodeList(unverified)} (their probe pod did not run)`
        : ''
      if (broken.length > 0) {
        return {
          name, status: 'warn',
          detail: brokenDetail(nodeList(broken)) + unverifiedTail + skippedTail,
          fix,
        }
      }
      if (unverified.length > 0) {
        // No fix here; the gate blamed for the failure carries it.
        return {
          name, status: 'warn',
          detail: `unverified on ${nodeList(unverified)} — their probe pod did not run `
            + '(the cause is reported by whichever of the *-nodes gates owns it)'
            + skippedTail,
        }
      }
      return { name, status: 'pass', detail: passDetail + skippedTail }
    }

    // A workspace-capable node the installer has not labelled cannot host a
    // sandboxed pod at all, so it is a runsc finding — and it is unprobeable,
    // so the other two gates can only call it unverified.
    const unlabelledNames = unlabelled.map((n) => n.name)

    return [
      gate(
        'runsc-nodes',
        [
          ...unlabelled.map((n) => `${n.name} (no ${GVISOR_NODE_LABEL} label)`),
          ...eligible.filter((n) => runscVerdict(n) === 'missing').map((n) => n.name),
        ],
        eligible.filter((n) => runscVerdict(n) === 'unknown').map((n) => n.name),
        gvisorFix(),
        (list) => `${RUNTIME_CLASS_GVISOR} unavailable on: ${list}`,
        `${RUNTIME_CLASS_GVISOR} accepted on all ${workspaceCapable.length} session-capable `
          + `nodes${sentryVerified > 0 ? ` (${sentryVerified} sentry-verified)` : ''}`,
      ),
      gate(
        'registry-nodes',
        failed.filter((o) => o.blame === 'registry').map(withCause),
        [...failed.filter((o) => o.blame !== 'registry').map((o) => o.node), ...unlabelledNames],
        REGISTRY_NODES_FIX,
        (list) => `could not pull from ${registryHost()} on: ${list}`,
        `all ${eligible.length} session-eligible nodes pulled from ${registryHost()}`,
      ),
      gate(
        'volume-nodes',
        [
          ...failed.filter((o) => o.blame === 'volume').map(withCause),
          ...outcomes
            .filter((o) => o.phase === 'Succeeded' && !(o.sawNonce && o.wroteMarker))
            .map((o) => `${o.node} (${o.sawNonce
              ? `uid ${probeUid} write did not reach the server's footing`
              : 'stale or absent mount'})`),
        ],
        [...failed.filter((o) => o.blame !== 'volume').map((o) => o.node), ...unlabelledNames],
        VOLUME_NODES_FIX,
        (list) => `the ${GLOBAL_CLAIM_NAME} claim is not the server's on: ${list}`,
        `shared data dir visible and writable at uid ${probeUid} from all `
          + `${eligible.length} session-eligible nodes`,
      ),
    ]
  } catch (err) {
    return uniform('warn', `multi-node readiness sweep errored (${truncate(err)})`)
  }
}

const NETPOL_PROBE_POD_NAME = 'yaac-cluster-check-egress'
const NFS_PORT = 2049

/**
 * The NFS server named by the global volume (csi-driver-nfs's `server`
 * attribute), resolved to an IP here because the probe pod has no working
 * DNS. `null` when the volume names no server; `ip` undefined when the name
 * cannot be resolved.
 */
async function sharedVolumeNfsServer(): Promise<{ server: string; ip?: string } | null> {
  const pvc = await kubectlGetJson<RawPvcRead>(['get', 'pvc', GLOBAL_CLAIM_NAME, '-n', k8sNamespace()])
  const volume = pvc?.spec?.volumeName
  const pv = volume ? await kubectlGetJson<RawPvRead>(['get', 'pv', volume]) : null
  const server = pv?.spec?.csi?.volumeAttributes?.server
  if (!server) return null
  if (isIP(server)) return { server, ip: server }
  const svc = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(\.|$)/.exec(server)
  if (svc) {
    const ip = (await execFileAsync('kubectl', [
      'get', 'svc', svc[1], '-n', svc[2], '-o', 'jsonpath={.spec.clusterIP}',
    ]).then((r) => r.stdout.trim(), () => '')) || undefined
    return { server, ip }
  }
  const ip = await dns.lookup(server).then((r) => r.address, () => undefined)
  return { server, ip }
}

/**
 * Verify the CNI enforces workspace egress policy; a non-enforcing CNI
 * fails open. A pod labeled like a workspace (but without the data-dir
 * label, so listWorkspacePods ignores it) must fail to reach, by IP:
 * the apiserver, the proxy's transparent port, the registry, the yaac
 * server, and the global volume's NFS server. Targets that do not exist
 * are reported as unverified.
 */
async function runNetworkPolicyProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    // Workspace egress is allowed only to netd's listener range, and the
    // proxy's transparent ports admit only node addresses (netd's Envoy).
    const nodeCidrs = await nodeIpBlocks()
    await kubectlApply(buildWorkspaceEgressNpManifest(nodeCidrs))
    await kubectlApply(buildProxyIngressNpManifest(nodeCidrs))
    const { stdout: rawIp } = await execFileAsync('kubectl', [
      'get', 'svc', 'kubernetes', '-n', 'default', '-o', 'jsonpath={.spec.clusterIP}',
    ])
    const apiserverIp = rawIp.trim()
    if (!apiserverIp) {
      return {
        name: 'egress', status: 'warn',
        detail: 'could not resolve the apiserver ClusterIP — enforcement unverified',
      }
    }

    // A direct dial to a transparent port would let a pod forge a
    // PROXY-protocol header and impersonate another workspace. The proxy
    // deploys on first workspace create, so it may be absent.
    let proxyIp: string | null = null
    try {
      const { stdout } = await execFileAsync('kubectl', [
        'get', 'svc', PROXY_APP_NAME, '-n', ns, '-o', 'jsonpath={.spec.clusterIP}',
      ])
      proxyIp = stdout.trim() || null
    } catch {
      proxyIp = null
    }
    const proxyCheck = proxyIp
      ? `; nc -w 4 ${proxyIp} ${TRANSPARENT_HTTPS_PORT} </dev/null >/dev/null 2>&1`
        + ' && echo NP_PROXY_OPEN || echo NP_PROXY_LOCKED'
      : ''

    // The registry serves every image anonymously and carries the trusted
    // images, so workspaces must not reach it.
    let registryIp: string | null = null
    try {
      const { stdout } = await execFileAsync('kubectl', [
        'get', 'svc', REGISTRY_SERVICE_NAME, '-n', REGISTRY_NAMESPACE,
        '-o', 'jsonpath={.spec.clusterIP}',
      ])
      registryIp = stdout.trim() || null
    } catch {
      registryIp = null
    }
    const registryCheck = registryIp
      ? `; nc -w 4 ${registryIp} ${REGISTRY_SERVICE_PORT} </dev/null >/dev/null 2>&1`
        + ' && echo NP_REGISTRY_OPEN || echo NP_REGISTRY_LOCKED'
      : ''

    // The server treats a loopback Host as its owner, so its ingress
    // policies are all that keep workspaces off the control plane
    // (docs/server-in-cluster.md).
    let serverIp: string | null = null
    try {
      const { stdout } = await execFileAsync('kubectl', [
        'get', 'svc', SERVER_APP_NAME, '-n', ns, '-o', 'jsonpath={.spec.clusterIP}',
      ])
      serverIp = stdout.trim() || null
    } catch {
      serverIp = null
    }
    const serverCheck = serverIp
      ? `; nc -w 4 ${serverIp} ${SERVER_POD_PORT} </dev/null >/dev/null 2>&1`
        + ' && echo NP_SERVER_OPEN || echo NP_SERVER_LOCKED'
      : ''

    // The NFS server trusts any client-claimed uid (AUTH_SYS), so a
    // workspace reaching it could read and write every project. Not
    // present on kind.
    const nfs = await sharedVolumeNfsServer()
    const nfsCheck = nfs?.ip
      ? `; nc -w 4 ${nfs.ip} ${String(NFS_PORT)} </dev/null >/dev/null 2>&1`
        + ' && echo NP_NFS_OPEN || echo NP_NFS_LOCKED'
      : ''

    const imageRef = await pushImageToRegistry(PROBE_LOCAL_TAG)
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: NETPOL_PROBE_POD_NAME,
        namespace: ns,
        labels: workspaceIdLabels('cluster-check-egress-probe'),
      },
      spec: {
        restartPolicy: 'Never',
        // Same runtime as workspace pods, so gVisor netstack traffic is
        // covered.
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        containers: [{
          name: 'probe',
          image: imageRef,
          command: [
            'sh', '-c',
            `nc -w 4 ${apiserverIp} 443 </dev/null && echo NP_REACHED || echo NP_BLOCKED`
            + proxyCheck + registryCheck + serverCheck + nfsCheck,
          ],
        }],
      },
    }, {
      timeoutMs: 60_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'egress', status: 'fail',
        detail: `egress probe pod ended in phase ${phase}`,
        fix: KIND_SETUP_FIX,
      }
    }

    if (logs.includes('NP_REACHED')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the apiserver directly — the CNI is not enforcing NetworkPolicy',
        fix: 'Session egress lockdown fails open without NetworkPolicy '
          + 'enforcement, leaving the proxy allowlist advisory. Re-run '
          + '`yaac cluster install`, which installs Calico as the CNI and '
          + 'policy engine.\nOn a byo cluster, whose CNI yaac did not install, '
          + 'this is the probe that says its engine '
          + 'is not actually enforcing plain networking.k8s.io/v1 policy — '
          + '"Calico is installed" does not imply it. Policy-only Calico over '
          + 'a foreign IPAM needs its policy plane genuinely wired up.',
      }
    }
    if (logs.includes('NP_REGISTRY_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the image registry directly — the bus '
          + 'every workspace image and the trusted chain travel on',
        fix: 'Session egress must default-deny everything but the node\'s netd '
          + 'listener range, and the registry admits only the node and builder '
          + 'pods. Restart the yaac server so both policies are re-applied.',
      }
    }
    if (logs.includes('NP_SERVER_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the yaac server directly — '
          + 'claiming a loopback Host makes it the server\'s owner, so any session '
          + 'could drive the control plane that manages every other one',
        fix: `The ${SERVER_INGRESS_NP_NAME} and ${SERVER_FRONT_INGRESS_NP_NAME} `
          + 'NetworkPolicies must admit the server port from the node addresses '
          + 'and the fronting alone, so a pod dialing the Service or pod IP is '
          + 'dropped. Re-run `yaac cluster install`, which applies both with '
          + 'the Deployment (the server re-applies the node half on start).',
      }
    }
    if (logs.includes('NP_NFS_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: `a session-labeled pod reached the NFS server behind ${GLOBAL_CLAIM_NAME} `
          + `(${nfs?.server ?? '?'}) — it trusts whatever uid a client claims, so any session `
          + 'could read and write every project as anyone',
        fix: 'Session egress must default-deny everything but the node\'s netd listener '
          + 'range. Restart the yaac server so the session policy is re-applied, and '
          + 'firewall the NFS server to the node addresses as well — a kernel mount comes '
          + 'from the node, never from a pod.',
      }
    }
    if (logs.includes('NP_PROXY_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod dialed a proxy transparent port directly — the forgery lock is open, so a pod could impersonate another session',
        fix: 'The proxy-ingress NetworkPolicy must admit the transparent '
          + 'ports from the node CIDRs only, and the session-egress policy '
          + 'must admit nothing but the netd listener range. Restart the '
          + 'yaac server so ensureProxyResources re-applies both.',
      }
    }
    // Without its egress policy, the proxy would let a workspace with a `*`
    // allowlist reach the server's node port as its owner. No pod probe can
    // test that path, so check the policy exists.
    if (proxyIp && !await kubectlGetJson(['get', 'networkpolicy', PROXY_EGRESS_NP_NAME, '-n', ns])) {
      return {
        name: 'egress', status: 'fail',
        detail: `the egress proxy has no ${PROXY_EGRESS_NP_NAME} NetworkPolicy — a session whose `
          + 'allowlist admits any host could reach the server through it as its owner',
        fix: 'Restart the yaac server (`yaac server restart`), which applies it on start.',
      }
    }
    if (logs.includes('NP_BLOCKED')) {
      const denied: string[] = []
      if (proxyIp) denied.push('a transparent port directly (forgery lock holds)')
      if (registryIp) denied.push('the image registry')
      if (serverIp) denied.push('the yaac server')
      if (nfs?.ip) denied.push(`the NFS server ${nfs.server}`)
      const deniedHalf = denied.length ? `, and cannot dial ${denied.join(', nor ')}` : ''
      const unverified: string[] = []
      if (!proxyIp) unverified.push('proxy not deployed — forgery-lock half unverified')
      if (!registryIp) unverified.push('registry not deployed — that half unverified')
      if (!serverIp) unverified.push('server not deployed in-cluster — that half unverified')
      if (nfs && !nfs.ip) unverified.push(`NFS server ${nfs.server} unresolvable from here — that half unverified`)
      const unverifiedHalf = unverified.length ? ` (${unverified.join('; ')})` : ''
      return {
        name: 'egress', status: 'pass',
        detail: `session egress is default-denied at the CNI${deniedHalf}${unverifiedHalf}`,
      }
    }
    return {
      name: 'egress', status: 'fail',
      detail: `egress probe produced no verdict (logs: ${logs.trim().slice(0, 80) || 'empty'})`,
      fix: KIND_SETUP_FIX,
    }
  } catch (err) {
    return {
      name: 'egress', status: 'fail',
      detail: `egress probe errored (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

const NPM_CACHE_PROBE_POD_NAME = 'yaac-cluster-check-npm-cache'

/** A small, long-published tarball, fetched with its packument the way
 *  pnpm fetches one. */
const NPM_CACHE_PROBE_PATHS = ['is-number', 'is-number/-/is-number-7.0.0.tgz']

/** A function because the namespace must not be read at import time. */
function npmCacheFix(): string {
  return 'Re-run `yaac cluster install`, which deploys the npm cache. Inspect it with '
    + `\`kubectl -n ${k8sNamespace()} get pods,pvc -l app=${NPM_CACHE_APP_NAME}\` and `
    + `\`kubectl -n ${k8sNamespace()} logs deploy/${NPM_CACHE_APP_NAME}\`.`
}

/**
 * Check the npm cache serves workspaces: a gVisor pod labeled like a
 * workspace of a cache-using project fetches a packument and tarball via
 * the cache's ClusterIP. This covers the network policies and the cache's
 * route to npmjs.
 *
 * No ready cache is a warn: new workspaces then install from npmjs
 * (`servingNpmCacheUrl`). A ready cache that fails to serve is a fail,
 * since new workspaces would install through it.
 */
async function runNpmCacheProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
      'get', 'service', NPM_CACHE_APP_NAME, '-n', ns,
    ])
    const ip = svc?.spec?.clusterIP
    if (!ip || await servingNpmCacheUrl() === null) {
      return {
        name: 'npm-cache', status: 'warn',
        detail: `${ip ? 'the npm cache has no ready pod' : 'no npm cache in this install'} `
          + '— workspaces install from npmjs',
        fix: npmCacheFix(),
      }
    }
    const fetches = NPM_CACHE_PROBE_PATHS
      .map((p) => `wget -q -T 60 -O /dev/null http://${ip}:${NPM_CACHE_PORT}/${p}`)
      .join(' && ')
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: NPM_CACHE_PROBE_POD_NAME,
        namespace: ns,
        labels: { ...workspaceIdLabels('cluster-check-npm-cache-probe'), [LABEL_NPM_CACHE]: 'true' },
      },
      spec: {
        restartPolicy: 'Never',
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        containers: [{
          name: 'probe',
          image: await pushImageToRegistry(PROBE_LOCAL_TAG),
          command: ['sh', '-c', `(${fetches}) && echo NPM_CACHE_OK || echo NPM_CACHE_FAILED`],
        }],
      },
    }, {
      timeoutMs: 150_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase === 'Succeeded' && logs.includes('NPM_CACHE_OK')) {
      return {
        name: 'npm-cache', status: 'pass',
        detail: `a session pod fetched a package through ${NPM_CACHE_APP_NAME}`,
      }
    }
    return {
      name: 'npm-cache', status: 'fail',
      detail: `a session pod could not fetch a package through ${NPM_CACHE_APP_NAME} `
        + `(phase ${phase}${logs.trim() ? `, logs: ${logs.trim().slice(0, 80)}` : ''}), `
        + 'so every session\'s pnpm install fails',
      fix: npmCacheFix(),
    }
  } catch (err) {
    return {
      name: 'npm-cache', status: 'fail',
      detail: `npm cache probe errored (${truncate(err)})`,
      fix: npmCacheFix(),
    }
  }
}

/**
 * `container: reason` for every not-ready netd container, from
 * `kubectl get pods -o json`. Returns nothing on unparseable input; it only
 * adds detail to a failure already reported.
 */
export function netdNotReadyContainers(podsJson: string): string[] {
  let parsed: {
    items?: Array<{
      status?: {
        containerStatuses?: Array<{
          name?: string
          ready?: boolean
          state?: Record<string, { reason?: string } | undefined>
        }>
      }
    }>
  }
  try {
    parsed = JSON.parse(podsJson || '{}') as typeof parsed
  } catch {
    return []
  }
  const out: string[] = []
  for (const pod of parsed.items ?? []) {
    for (const c of pod.status?.containerStatuses ?? []) {
      if (c.ready !== false || !c.name) continue
      const reason = Object.values(c.state ?? {})[0]?.reason ?? 'not ready'
      if (!out.includes(`${c.name}: ${reason}`)) out.push(`${c.name}: ${reason}`)
    }
  }
  return out
}

/**
 * The datapath gate: calico-node and netd must both be Ready. Without
 * Calico, egress policy is not enforced (fails open); without netd,
 * workspaces have no redirect and lose egress (fails closed).
 */
async function runDatapathCheck(): Promise<CheckResult> {
  try {
    const { stdout: calico } = await execFileAsync('kubectl', [
      'get', 'daemonset', 'calico-node', '-n', 'kube-system',
      '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
    ])
    const [calicoReady, calicoWanted] = calico.trim().split('/').map(Number)
    if (!(calicoReady > 0) || calicoReady !== calicoWanted) {
      return {
        name: 'datapath', status: 'fail',
        detail: `calico-node is ${calico.trim()} ready — NetworkPolicy is not being enforced`,
        fix: 'Calico is the CNI and policy engine. Re-run `yaac cluster install` '
          + '(on a byo cluster, whose Calico yaac did not install, `--byo`), '
          + 'or inspect with `kubectl -n kube-system get pods -l k8s-app=calico-node`.',
      }
    }

    const { stdout: netd } = await execFileAsync('kubectl', [
      'get', 'daemonset', NETD_APP_NAME, '-n', k8sNamespace(),
      '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
    ]).catch(() => ({ stdout: '' }))
    const [netdReady, netdWanted] = netd.trim().split('/').map(Number)
    if (!netd.trim() || !(netdReady > 0) || netdReady !== netdWanted) {
      const { stdout: pods } = await execFileAsync('kubectl', [
        'get', 'pods', '-n', k8sNamespace(), '-l', `app=${NETD_APP_NAME}`, '-o', 'json',
      ]).catch(() => ({ stdout: '' }))
      // Name the unhealthy container: netd's readiness is Envoy's config
      // ack, so the DaemonSet counts cannot tell netd and Envoy apart.
      const blocked = netdNotReadyContainers(pods)
      return {
        name: 'datapath', status: 'fail',
        detail: netd.trim()
          ? `${NETD_APP_NAME} is ${netd.trim()} ready — session egress has no redirect`
            + (blocked.length ? ` (${blocked.join(', ')})` : '')
          : `${NETD_APP_NAME} is not deployed — session egress has no redirect`,
        fix: 'netd steers session egress into the proxy. `yaac cluster install` '
          + 're-applies it (the server also re-ensures it whenever it '
          + 'brings the proxy up). Inspect both containers with '
          + `\`kubectl -n ${k8sNamespace()} logs ds/${NETD_APP_NAME} -c netd\` and `
          + '`-c envoy`.',
      }
    }
    return {
      name: 'datapath', status: 'pass',
      detail: `calico-node and ${NETD_APP_NAME} ready (policy enforced, egress redirected)`,
    }
  } catch (err) {
    return {
      name: 'datapath', status: 'fail',
      detail: `could not query the datapath components (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  }
}

/**
 * The pod-to-veth gate: read each node's routing table through its netd
 * pod and judge it with `assessVethSource`, the same verdict `--byo` uses.
 */
async function runVethSourceCheck(): Promise<CheckResult> {
  const prefix = cniVethPrefix()
  try {
    const outcomes = await probeWorkloadVeths(execFileAsync, prefix)
    const { status, detail, fix } = assessVethSource(outcomes, prefix)
    return { name: 'veth-source', status, detail, ...(fix ? { fix } : {}) }
  } catch (err) {
    return {
      name: 'veth-source', status: 'warn',
      detail: `could not read the node routing tables (${truncate(err)}) — the pod → veth `
        + `source for ${prefix}* is unverified`,
    }
  }
}

const NESTED_PROBE_POD_NAME = 'yaac-cluster-check-nested'

/**
 * Warn-level gate for nestedContainers workspaces. Under gvisor-nested with
 * the engine's capabilities, in-sandbox root must be able to mount a tmpfs,
 * as every container start and `docker build` step does. Other engine
 * needs (setuid, file caps) are covered by the nested-containers e2e.
 */
async function runNestedMountProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    const imageRef = await pushImageToRegistry(PROBE_LOCAL_TAG)
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: NESTED_PROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        runtimeClassName: RUNTIME_CLASS_GVISOR_NESTED,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: imageRef,
          // Root with the engine's caps; mount() needs SYS_ADMIN.
          securityContext: {
            runAsUser: 0,
            capabilities: { add: NESTED_ENGINE_CAPS },
          },
          command: [
            'sh', '-c',
            'mkdir -p /tmp/m && mount -t tmpfs none /tmp/m '
            + '&& echo NESTED_MOUNT_OK || echo NESTED_MOUNT_FAIL',
          ],
        }],
      },
    }, {
      timeoutMs: 60_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'nested-mount', status: 'warn',
        detail: `nested probe pod ended in phase ${phase} — nestedContainers sessions unverified`,
        fix: NESTED_MOUNT_FIX,
      }
    }
    if (logs.includes('NESTED_MOUNT_OK')) {
      return {
        name: 'nested-mount', status: 'pass',
        detail: 'in-sandbox mount under gvisor-nested verified (nestedContainers ready)',
      }
    }
    return {
      name: 'nested-mount', status: 'warn',
      detail: 'mounting tmpfs under the gvisor-nested sentry failed'
        + ` (logs: ${logs.trim().slice(0, 80) || 'empty'})`,
      fix: NESTED_MOUNT_FIX,
    }
  } catch (err) {
    return {
      name: 'nested-mount', status: 'warn',
      detail: `nested sentry-mount probe errored (${truncate(err)})`,
      fix: NESTED_MOUNT_FIX,
    }
  }
}

const NESTED_MOUNT_FIX =
  'Only nestedContainers sessions are affected (docker build/run in-pod). '
  + 'The gvisor-nested runsc handler is broken or the sentry refuses the '
  + 'mount — run `yaac cluster install` to re-apply the runsc '
  + 'installer DaemonSet, which reinstalls the binaries and rewrites the '
  + 'handlers.'

/**
 * The builder-pod guard is a ValidatingAdmissionPolicy, and
 * `ensureBuilderRoleGuard` refuses to proceed without the API, so no image
 * can be built. Uses the same `vapAvailable` test as the guard.
 */
async function runVapAvailabilityCheck(): Promise<CheckResult> {
  if (await vapAvailable()) {
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

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg.split('\n')[0]
}
