import {
  buildProxyIngressNpManifest,
  buildWorktreeEgressNpManifest,
  cniVethPrefix,
  ensureNamespace,
  nodeIpBlocks,
  vapAvailable,
} from '#drivers/k8s/cluster'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  GVISOR_NODE_LABEL,
  LABEL_WORKTREE_ID,
  NESTED_ENGINE_CAPS,
  NETD_APP_NAME,
  PROXY_APP_NAME,
  SERVER_APP_NAME,
  SERVER_POD_PORT,
  RUNTIME_CLASS_GVISOR,
  RUNTIME_CLASS_GVISOR_NESTED,
  TRANSPARENT_HTTPS_PORT,
  buildPriorityClassManifests,
  execFileAsync,
  formatTaint,
  k8sNamespace,
  kubectlApply,
  runPodToCompletion,
  runtimeClassSpec,
  podUid,
  untoleratedTaints,
  worktreeIdLabels,
} from '#drivers/k8s/substrate'
import type { NodeTaint, PodToleration } from '#drivers/k8s/substrate'
import { assessVethSource, probeWorkloadVeths } from './cni-adopt'
import {
  REGISTRY_NAMESPACE,
  REGISTRY_SERVICE_NAME,
  REGISTRY_SERVICE_PORT,
  pushImageToRegistry,
  registryHost,
  registryReachable,
} from '#drivers/k8s/container'
import { sharedRoot } from '@yaac/shared/paths'
// CheckResult lives in @yaac/shared/types, not here with its producer, so
// consumers can name the shape without importing the check suite.
import type { CheckResult } from '@yaac/shared/types'

/** Render one result as the CLI line `yaac cluster check` prints. */
export { formatCheckResult } from '@yaac/shared/checks'

/** Probe image used for the end-to-end registry-pull + hostPath check. */
const PROBE_SOURCE_IMAGE = 'docker.io/library/busybox:1.36'
const PROBE_LOCAL_TAG = 'yaac-cluster-probe:busybox-1.36'
const PROBE_POD_NAME = 'yaac-cluster-check'

const KIND_SETUP_FIX = [
  'Create a kind cluster wired for yaac by running:',
  '  yaac cluster install',
  'It provisions the podman machine (macOS), the kind cluster (home',
  'extraMount), Calico, the node fixups, every built-in image, and the',
  'in-cluster registry.',
].join('\n')

/**
 * Node-state the install applies and this check verifies. Shared with
 * install.ts (which imports them) so `yaac cluster install` and the
 * node-fixups check below can never drift apart.
 */
export const NODE_TASKSMAX_CONF = '/etc/systemd/system.conf.d/10-yaac-tasksmax.conf'
export const NODE_MIN_FREE_KBYTES = 262144
export const NODE_PIDS_LIMIT = 32768
/**
 * inotify ceilings. Unlike everything else here these are host-global
 * rather than per-node — the kind nodes are containers in the host's
 * init user namespace, so all of them draw on the ONE root-uid pool.
 * Every node therefore multiplies the demand against a fixed budget, and
 * the stock 128 instances is not enough for a multi-node cluster: netd's
 * Envoy asserts on `inotify_fd_ >= 0` and dies with SIGSEGV, which
 * presents as every worktree losing its egress redirect rather than as
 * anything mentioning inotify. Applied on each node for the same reason
 * install re-applies the vm sysctls — whichever node runs it, the
 * write lands on the host.
 */
export const NODE_INOTIFY_MAX_USER_INSTANCES = 1024
export const NODE_INOTIFY_MAX_USER_WATCHES = 524288
/**
 * kubelet cAdvisor housekeeping interval (default 10s). Its per-container
 * process stats readlink EVERY open fd of EVERY process in each container
 * cgroup per tick; a gVisor worktree sandbox concentrates ~9k host fds in
 * one sentry process (directfs handles, gofer channels), so at the default
 * interval kubelet alone burned 1.5–2 cores on a 5-worktree node (pprof:
 * >90% in cadvisor processStatsFromProcs → syscall.Readlink). Even at 60s
 * a 4-worktree node still measured kubelet at ~1.1 cores with >90% of its
 * profile in the same readlink storm, so the interval is stretched to
 * 300s; the cost is slower node-level stats (metrics/eviction reaction) —
 * worktree OOMs are enforced by the pod memcg limit and are unaffected.
 */
export const NODE_KUBELET_HOUSEKEEPING_INTERVAL = '300s'
/** kubeadm-written kubelet flags file the fixup edits (kind node fs —
 *  persists across node restarts, unlike the sysctl fixups). */
export const NODE_KUBELET_FLAGS_ENV = '/var/lib/kubelet/kubeadm-flags.env'

/**
 * Run the full preflight suite for the kubernetes backend. Returns every
 * result plus an overall ok flag (false when any hard check failed).
 *
 * Checks, in order:
 *   1. kubectl binary present
 *   2. cluster API server reachable
 *   3. node inventory: how many nodes, how many of them can schedule a
 *      worktree, and are they all Ready
 *   4. podman present (the image build engine)
 *   5. the in-cluster registry answering (through this process's route to
 *      it — a kubectl port-forward, or the outer project registry nested)
 *   6. yaac namespace exists / can be created
 *   6b. node fixups (warn-only, kind nodes only): DefaultTasksMax,
 *      vm.min_free_kbytes, the kubelet housekeeping interval, and node
 *      pids-limit that `yaac cluster install` applies — most live in node/VM
 *      state and vanish on restart — detect and point at
 *      `yaac cluster install`
 *   6c. gvisor: the gvisor/gvisor-nested RuntimeClasses exist, at least one
 *      node carries the label they schedule on (the installer DaemonSet
 *      landed the runtime somewhere), AND a pod on the gvisor class is
 *      actually sentry-sandboxed (dmesg fingerprint) — worktree pods cannot
 *      run without all three
 *   7. end-to-end probe: push a tiny image to the registry, run a pod
 *      from its cluster ref (on the default gvisor tier) that reads
 *      a nonce file from a hostPath mount of the data dir and writes a
 *      marker back at the worktree uid — proves in-cluster registry
 *      pulls, host-visible hostPath, AND unprivileged hostPath writes
 *      through the gofer in one shot
 *   8. egress enforcement: a worktree-labeled pod (gvisor, like real
 *      worktrees) cannot reach the apiserver (CNI enforces policy) and
 *      cannot dial a proxy transparent port directly (the forgery lock —
 *      those ports are admitted from the node CIDRs only, so nothing but
 *      netd's Envoy can reach them)
 *   8b. multi-node readiness (warn-only, multi-node clusters only):
 *      one pinned probe pod per worktree-eligible node proves the three
 *      things a worktree needs from the node it lands on — the gvisor
 *      RuntimeClass is accepted there (runsc-nodes), its containerd can
 *      pull from the registry (registry-nodes), and the shared data dir is
 *      the same bytes the server sees (volume-nodes)
 *   9. datapath: calico-node is Ready (NetworkPolicy is enforced at all)
 *      and yaac-netd is Ready (worktree egress has a redirect).
 *      half of the same guarantee, warn-level until it is deployed
 *   9b. veth-source: the pod → veth binding the redirect keys on actually
 *      resolves on every node, for the configured prefix. Not covered by
 *      the datapath gate: netd's readiness is Envoy's config ack, which is
 *      green with zero pod → veth mappings, so a wrong prefix leaves a Ready
 *      netd whose chain has no per-pod rules in it
 *  10. nested-mount (warn-only): under the nested worktree securityContext
 *      (gvisor-nested + the engine's in-sandbox caps) in-sandbox root can
 *      mount a tmpfs — the core sentry prerequisite for the rootful in-pod
 *      engine (nestedContainers; suid/file-caps are covered by the e2e)
 *  11. runtime-stamp (warn-only): every UNTRUSTED pod — the worktree pods,
 *      by their yaac.worktree-id label — carries a gvisor-tier
 *      runtimeClassName. Trusted infra (proxy, registries, node-write)
 *      deliberately stamps none and runs on runc.
 */
export async function runClusterCheck(
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const add = (r: CheckResult): void => { results.push(r) }

  // 1. kubectl present
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

  // 2. cluster reachable.
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

  // 3. node inventory — the input to the multi-node readiness gates below.
  // Whether a node can take a worktree is a question about the SESSION pod's
  // tolerations as much as the node's taints, and those live on the gvisor
  // RuntimeClass (the admission controller merges them into every pod naming
  // it), so the class is read here and handed down to the sweep rather than
  // re-read there. A cluster with no such class — a fresh install — yields
  // no tolerations, which is the honest answer for pods that stamp no
  // class.
  const gvisorScheduling = await gvisorRuntimeClass()
  let nodes: ClusterNode[] = []
  try {
    nodes = await listClusterNodes(gvisorScheduling.tolerations)
    add(nodeInventoryResult(nodes))
  } catch (err) {
    add({ name: 'nodes', status: 'warn', detail: `could not list nodes (${truncate(err)})` })
  }

  // 4. podman (build engine)
  try {
    await execFileAsync('podman', ['--version'])
    add({ name: 'podman', status: 'pass', detail: 'installed (image build engine)' })
  } catch {
    add({
      name: 'podman', status: 'fail', detail: 'not found on PATH',
      fix: 'Install podman — yaac builds session images with it.',
    })
  }

  // 5. registry. Reachability here means "this process can reach it",
  // which for a top-level install is a kubectl port-forward into the
  // registry Deployment — so a failure is either an absent Deployment or
  // an apiserver that will not forward, never a host networking question.
  if (await registryReachable()) {
    add({ name: 'registry', status: 'pass', detail: `serving as ${registryHost()}` })
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

  // 6. namespace
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

  // 6a. PriorityClasses — cluster-scoped objects the pod builders name;
  // read-only, so it runs before the probe gates rather than behind them.
  add(await runPriorityClassCheck())

  // 6b–7. node fixups + gvisor + end-to-end probe (skipped when
  // prerequisites already failed)
  const PROBE_GATES = [
    'node-fixups', 'gvisor', 'probe', 'egress', 'datapath', 'veth-source',
    ...MULTI_NODE_GATES,
    'nested-mount', 'vap', 'runtime-stamp',
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

  // The e2e probe schedules a pod on the gvisor tier — with the
  // RuntimeClass missing it would sit Pending to its full timeout, so a
  // gvisor failure gates it.
  if (results.some((r) => r.status === 'fail')) {
    skipFrom('probe', 'skipped — fix the failures above first')
    return { ok: false, results }
  }
  // 8. The three pod-based probes, CONCURRENTLY. Each starts its own
  // gVisor sandbox, and serially they were most of the check's wall time
  // (~19s of a 71s `cluster install`). They share nothing: distinct pod
  // names, distinct nonce files, and the policies the egress probe
  // applies are the ones the server applies anyway. The gvisor gate above
  // still runs first, so none of them can sit Pending to its timeout
  // waiting for a RuntimeClass that will never appear — which is the one
  // ordering that was ever load-bearing.
  const [probeResult, egressResult, nestedMountResult, multiNodeResults] = await Promise.all([
    runEndToEndProbe(),
    runNetworkPolicyProbe(),
    runNestedMountProbe(),
    runMultiNodeReadiness(nodes, gvisorScheduling),
  ])
  add(probeResult)
  add(egressResult)

  // 9. datapath: Calico enforcing + netd up. (No top-level relay gate:
  // the server reaches the relay through a kubectl port-forward, the same
  // apiserver access the checks above already prove — there is no
  // cluster-shape wiring to verify.)
  add(await runDatapathCheck())

  // 9b. veth-source: the redirect's pod → veth binding actually resolves on
  // every node, for the prefix netd was configured with. Separate from the
  // datapath gate above because the two fail differently and the datapath
  // gate CANNOT see this one: netd's readiness is Envoy's config ack, which
  // is green with zero pod → veth mappings. So a wrong prefix (or a CNI that
  // writes no per-workload route) leaves netd Ready, its chain empty of
  // per-pod rules, and every worktree quietly without egress. Re-checked on
  // every run, not just at `--adopt-cni` time, since a node pool added later
  // can differ from the one adoption sampled.
  add(await runVethSourceCheck())

  // 8b. multi-node readiness. Ran above, alongside the other pod probes;
  // reported here because a node that cannot pull or cannot see the shared
  // dir is a *scheduling* failure, and the datapath verdict above is what
  // tells you whether the node has a redirect at all.
  for (const r of multiNodeResults) add(r)

  // 10. nested userns-mount probe (warn-only: only nestedContainers
  // worktrees need it — the tripwire for containerd versions where the
  // namespaced SYS_ADMIN grant does not unlock the mount family). Ran
  // above, alongside the other pod probes.
  add(nestedMountResult)

  // 10b. ValidatingAdmissionPolicy availability: the builder-pod guard
  // refuses to apply without it, fail-closed, so no image can be built.
  add(await runVapAvailabilityCheck())

  // 11. runtime-stamp sweep (warn-only): every untrusted pod must carry a
  // gvisor-tier runtimeClassName.
  add(await runRuntimeStampSweep())

  // 12. the server pod's git identity vs this host's (warn-only).

  return { ok: !results.some((r) => r.status === 'fail'), results }
}



/**
 * What the readiness gates need to know about one node. `schedulable` is
 * "a worktree pod could land here", and it is answered by real per-taint
 * matching (untoleratedTaints) against the tolerations the gvisor
 * RuntimeClass merges into every sandboxed pod — not by "carries no taint at
 * all", which is the same answer only while nothing tolerates anything, and
 * which would report a deliberately tainted worktrees pool as zero usable
 * nodes. `excludedBecause` is the human half of that verdict, empty when the
 * node is schedulable: a narrowed sweep has to be able to say WHICH nodes it
 * left out and why, or a node sitting under a transient memory-pressure
 * taint just silently stops being reported on.
 *
 * `runtimeHandlers` is the kubelet's report of the runtimes containerd
 * registered (kubernetes >= 1.30); it is empty on clusters that do not
 * publish it, which is why it only ever *adds* confidence below.
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
 * Why a worktree cannot land on this node, or '' when one can. Cordoning is
 * reported separately from its taints even though kubernetes also expresses
 * it as one, because the two have different repairs (`kubectl uncordon` vs.
 * a toleration the RuntimeClass has to declare).
 */
function worktreeExclusion(node: RawNodeItem, tolerations: PodToleration[]): string {
  if (node.spec?.unschedulable === true) return 'cordoned'
  const blocking = untoleratedTaints(node.spec?.taints, tolerations)
  if (blocking.length === 0) return ''
  return `untolerated taint ${blocking.map(formatTaint).join(', ')}`
}

async function listClusterNodes(tolerations: PodToleration[]): Promise<ClusterNode[]> {
  const { stdout } = await execFileAsync('kubectl', ['get', 'nodes', '-o', 'json'])
  const items = (JSON.parse(stdout) as { items?: RawNodeItem[] }).items ?? []
  return items.map((n) => {
    const excludedBecause = worktreeExclusion(n, tolerations)
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

/** `name (why)` for every node a worktree cannot land on, truncated. */
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
 * The node inventory line. Multi-node is a supported topology now (the
 * local backend renders it with `yaac cluster install --nodes N`), so node
 * count alone is never a warning — what is worth flagging is a node that
 * cannot take work: NotReady, or cordoned/tainted in a way no worktree pod
 * tolerates. The readiness gates below say whether the nodes that CAN take a
 * worktree are actually equipped for one.
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
  // The excluded nodes are named even on a pass: "2 of 3" without saying
  // which one dropped out reads as a healthy cluster right up until the node
  // that dropped out was the one under memory pressure.
  return {
    name: 'nodes', status: 'pass',
    detail: `${nodes.length} nodes, ${eligible.length} able to schedule sessions`
      + (eligible.length < nodes.length ? `; skipping ${excludedList(nodes)}` : ''),
  }
}

const NODE_FIXUPS_FIX =
  'These fixups live in node/VM state and vanish on a node or VM restart. '
  + 'Re-apply them with: yaac cluster install'

/**
 * Warn-level detection for the node fixups `yaac cluster install` applies. The
 * TasksMax / vm.min_free_kbytes / pids-limit fixups fail late — worktrees die
 * mid-flight under subagent fan-out or virtiofs pressure — so worktrees can
 * look healthy on a cluster that lost them to a restart. Probing is
 * kind-specific (node name == podman container name): a node that is not a
 * podman container self-skips.
 */
async function runNodeFixupsCheck(): Promise<CheckResult> {
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
          `test -f ${NODE_TASKSMAX_CONF} && echo tasksmax=ok || echo tasksmax=missing; `
          + 'echo minfree=$(cat /proc/sys/vm/min_free_kbytes); '
          + 'echo inotifyinst=$(cat /proc/sys/fs/inotify/max_user_instances); '
          + 'echo inotifywatch=$(cat /proc/sys/fs/inotify/max_user_watches); '
          + `grep -q -- '--housekeeping-interval=${NODE_KUBELET_HOUSEKEEPING_INTERVAL}' `
          + `${NODE_KUBELET_FLAGS_ENV} && echo hk=ok || echo hk=missing`,
        ])
        report = res.stdout
      } catch {
        return {
          name: 'node-fixups', status: 'skip',
          detail: `node "${node}" is not a podman container — kind node fixups not applicable`,
        }
      }
      if (report.includes('tasksmax=missing')) missing.add('DefaultTasksMax (subagent fan-out)')
      const minfree = Number(/minfree=(\d+)/.exec(report)?.[1] ?? '0')
      if (minfree < NODE_MIN_FREE_KBYTES) missing.add('vm.min_free_kbytes (virtiofs I/O)')
      // Host-global, so one node reporting low condemns the whole cluster —
      // which is right: that is the pool every node's Envoy draws from.
      const inotifyInst = Number(/inotifyinst=(\d+)/.exec(report)?.[1] ?? '0')
      if (inotifyInst < NODE_INOTIFY_MAX_USER_INSTANCES) {
        missing.add('fs.inotify.max_user_instances (netd Envoy startup)')
      }
      const inotifyWatch = Number(/inotifywatch=(\d+)/.exec(report)?.[1] ?? '0')
      if (inotifyWatch < NODE_INOTIFY_MAX_USER_WATCHES) {
        missing.add('fs.inotify.max_user_watches (netd Envoy startup)')
      }
      // Default-interval cAdvisor housekeeping burns whole kubelet cores
      // against gVisor sandboxes — see NODE_KUBELET_HOUSEKEEPING_INTERVAL.
      if (report.includes('hk=missing')) {
        missing.add('kubelet housekeeping-interval (cAdvisor stats CPU)')
      }
      const { stdout: pidsRaw } = await execFileAsync('podman', [
        'inspect', '--format', '{{.HostConfig.PidsLimit}}', node,
      ])
      const pids = Number(pidsRaw.trim())
      if (Number.isFinite(pids) && pids > 0 && pids < NODE_PIDS_LIMIT) {
        missing.add('node pids-limit')
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
      detail: 'TasksMax, vm sysctls, kubelet housekeeping, and pids-limit in place',
    }
  } catch (err) {
    return {
      name: 'node-fixups', status: 'warn',
      detail: `could not verify node fixups (${truncate(err)})`,
      fix: NODE_FIXUPS_FIX,
    }
  }
}

/**
 * Make the probe image available in the local registry (pulling/tagging
 * the busybox source once) and return its in-cluster ref — shared by every
 * probe that schedules a pod.
 */
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

/**
 * The gVisor fix line. A function, not a const: it names the install
 * namespace, which is per-install (and per-e2e-run) and must not be
 * captured at import time.
 */
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
 * The PriorityClass gate: every yaac pod but the worktree pods of a nested
 * install names one, and the apiserver REJECTS a pod naming a class it does
 * not have — for a worktree that means the Job applies fine and then hangs
 * with no pod, which is the failure this probe exists to name. Drifted
 * values (a class an older yaac installed with different numbers) only warn:
 * the pods still schedule, they just rank wrong.
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
 * The gVisor gate: worktree pods run under `runtimeClassName: gvisor` with no
 * user namespace, so a cluster without the RuntimeClasses (or with a handler
 * that silently falls through to runc — which would run in-container root
 * UNSANDBOXED) cannot run worktrees safely. Two halves: the RuntimeClasses
 * exist, and a pod on the gvisor class is provably inside the sentry —
 * gVisor's dmesg prints its own boot messages ("Starting gVisor..."), while a
 * runc pod sees the node kernel's ring buffer.
 *
 * Between the two sits the node label the installer DaemonSet stamps, which
 * is what the RuntimeClasses schedule on. It is checked separately because
 * of what its absence looks like otherwise: the probe pod below would sit
 * Pending until the timeout and report "runsc cannot run pods on this node",
 * when the truth is that no node has the runtime yet and the scheduler is
 * refusing to place it anywhere. On a cluster whose RuntimeClasses predate
 * the selector, sandboxed pods do still schedule (the classes are only
 * replaced together with the installer that satisfies them) — so this reads
 * as "not converged yet", not "nothing can run". How MANY nodes carry it is
 * a multi-node readiness question, not this gate's.
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
 * Sandbox invariant sweep (warn-only): every pod hosting UNTRUSTED code
 * carries a gvisor-tier runtimeClassName. That's the worktree pods, found
 * by the yaac.worktree-id label the session builder stamps. Trusted infra
 * — proxy, registries, node-write pods — deliberately stamps no runtime
 * and runs on runc, so it is NOT flagged. An unsandboxed match is either
 * from a gVisor-less yaac era or from a builder/values knob that lost the
 * stamp. Warn rather than fail — such pods still run, just without the
 * sentry.
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
        && !!p.metadata.labels && LABEL_WORKTREE_ID in p.metadata.labels
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
 * The one check that exercises the full wiring: registry pull from inside
 * the cluster plus host-visible hostPath mounts. Failure modes map to the
 * two pieces of cluster install yaac cannot do itself (containerd registry
 * config, node extraMounts).
 */
async function runEndToEndProbe(): Promise<CheckResult> {
  // The SHARED root: the probe writes here and mounts the same directory
  // into a pod, which is exactly the visibility contract that tier states.
  const dataDir = sharedRoot()
  const nonce = crypto.randomUUID()
  const nonceFile = path.join(dataDir, '.cluster-check-nonce')
  const writeFile = path.join(dataDir, '.cluster-check-write')
  const ns = k8sNamespace()

  try {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(nonceFile, nonce)
    await fs.rm(writeFile, { force: true })

    // Make sure the probe image exists locally, then push it through the
    // same registry path worktree images take.
    const imageRef = await ensureProbeImage()

    const manifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: PROBE_POD_NAME, namespace: ns },
      spec: {
        restartPolicy: 'Never',
        // Mirror the worktree-pod containment (see buildPodJobManifest):
        // a host pod carries the gvisor RuntimeClass (no userns), so the
        // probe proves hostPath reads/writes work through the gofer at the
        // worktree uid.
        ...runtimeClassSpec(),
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: imageRef,
          // Run at the uid worktree images bake into their yaac user, and
          // prove a hostPath WRITE works at that uid — worktree setup's
          // first unprivileged write (the worktree gitdir pointer) fails
          // exactly here when the uids don't line up.
          securityContext: { runAsUser: podUid() },
          command: [
            'sh', '-c',
            'cat /probe/.cluster-check-nonce && echo ok > /probe/.cluster-check-write',
          ],
          volumeMounts: [{ name: 'probe', mountPath: '/probe' }],
        }],
        volumes: [{ name: 'probe', hostPath: { path: dataDir, type: 'Directory' } }],
      },
    }
    // Run to a terminal phase; image-pull errors and hostPath failures
    // both surface here.
    const { phase, logs } = await runPodToCompletion(manifest, {
      timeoutMs: 90_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    if (phase !== 'Succeeded') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod ended in phase ${phase}`,
        fix: 'If the pod is stuck in ImagePullBackOff, the node cannot '
          + `pull from ${registryHost()} — its containerd hosts.toml for `
          + 'that host is missing or stale; re-apply it with `yaac cluster '
          + 'install`.\nIf it failed mounting '
          + `/probe, the node cannot see ${dataDir} — add an extraMounts `
          + 'entry for your home directory to the kind config.\n'
          + 'If it never got past Pending or failed with a runsc/'
          + 'RuntimeClass error, the gvisor runtime is broken — run '
          + '`yaac cluster install` (re-applies the runsc installer '
          + 'DaemonSet).\n'
          + 'If it failed writing /probe/.cluster-check-write, uid '
          + `${podUid()} cannot write hostPath mounts — see the `
          + 'virtiofs ownership notes in docs/cluster-setup.md '
          + '("macOS: the podman machine").',
      }
    }
    if (logs.trim() !== nonce) {
      return {
        name: 'probe', status: 'fail',
        detail: 'probe pod read stale data from the hostPath mount',
        fix: `The node's view of ${dataDir} is not the host's — check the `
          + 'extraMounts entry in your kind config.',
      }
    }
    // The pod's write must round-trip to the host: this is the server-side
    // proof that a worktree's unprivileged uid can mutate hostPath mounts
    // (worktree, config dirs) — a read-only probe passes on clusters where
    // every worktree still dies on its first write.
    const written = await fs.readFile(writeFile, 'utf8').catch(() => null)
    if (written?.trim() !== 'ok') {
      return {
        name: 'probe', status: 'fail',
        detail: `probe pod's hostPath write (uid ${podUid()}) did not reach the host`,
        fix: 'Session pods write hostPath mounts as the yaac user, whose '
          + 'uid is baked in at image build time to match the server\'s. '
          + 'Rebuild session images (delete stale yaac-base/yaac-tools '
          + 'tags) and check the virtiofs ownership notes in '
          + 'docs/cluster-setup.md ("macOS: the podman machine").',
      }
    }
    return {
      name: 'probe', status: 'pass',
      detail: `registry pull + hostPath mount + uid ${podUid()} write verified`,
    }
  } catch (err) {
    return {
      name: 'probe', status: 'fail',
      detail: `probe errored (${truncate(err)})`,
      fix: KIND_SETUP_FIX,
    }
  } finally {
    await fs.rm(nonceFile, { force: true }).catch(() => { /* best-effort */ })
    await fs.rm(writeFile, { force: true }).catch(() => { /* best-effort */ })
  }
}

/** The readiness gates the multi-node sweep reports, in order. */
const MULTI_NODE_GATES = ['runsc-nodes', 'registry-nodes', 'volume-nodes'] as const

const NODE_PROBE_POD_PREFIX = 'yaac-cluster-check-node'
/** Nonce file for the per-node sweep — distinct from the e2e probe's, which
 *  runs concurrently and removes its own on the way out. */
const NODE_PROBE_NONCE_FILE = '.cluster-check-nodes-nonce'

/**
 * Which gate owns a probe pod that never ran. A pod that does not start
 * says nothing by itself — the same Pending is a node that cannot pull, a
 * node whose containerd has no runsc handler, and a node missing the home
 * extraMount — so the failure is attributed from the kubelet's own event
 * before it is reported, and `unknown` is carried as *unverified* on every
 * gate rather than silently passing one of them.
 */
type ProbeBlame = 'registry' | 'volume' | 'runsc' | 'unknown'

interface NodeProbeOutcome {
  node: string
  /** Terminal phase of the pinned probe pod ('Pending' when it never ran). */
  phase: string
  /** The sentry fingerprint showed up in the logs. Bonus, not a verdict:
   *  the probe runs at the worktree uid, which may not read dmesg at all. */
  sandboxed: boolean
  sawNonce: boolean
  wroteMarker: boolean
  /** Set when the pod did not succeed: which gate its failure belongs to. */
  blame: ProbeBlame
  /** The kubelet event the blame was read from, for the warn detail. */
  failureHint: string
}

/**
 * The gvisor RuntimeClass as the cluster holds it — the single source of
 * truth for where a sandboxed pod may go, because the RuntimeClass admission
 * controller merges both halves of `scheduling` into every pod naming the
 * class. So this reads what the SCHEDULER will see, not what a manifest
 * builder intended:
 *
 *  - `handler`: the containerd handler the class names.
 *  - `nodeSelector`: where such a pod may land. The gVisor installer stamps
 *    the label it selects on, so a node outside it is a node the runtime has
 *    not reached — reported as a runsc-nodes finding, not dropped.
 *  - `tolerations`: what such a pod tolerates, which is how a tainted
 *    worktrees pool is usable at all. Empty on the local backend (nothing is
 *    tainted there but the control plane, which worktrees genuinely cannot
 *    use), and empty on a cluster with no class at all — where the blanket
 *    "no taint tolerated" answer is the correct one.
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
 * The most recent Warning event the kubelet recorded for a pod, as
 * `reason: message`. Read AFTER the pod is gone (runPodToCompletion deletes
 * it), which works because events outlive their object — and is why this is
 * a separate call rather than a field of the pod status the poll already
 * sees: a pod stuck in Pending has no containerStatuses at all when the
 * failure is a volume mount.
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
 * Attribute a probe pod that never ran to the gate that can actually fix
 * it. The mount check comes first on purpose: kubelet sets volumes up
 * before it pulls, so a node missing the home extraMount fails at
 * FailedMount having never touched the registry — reporting that as a
 * registry problem would hand the user a fix (install rewrites
 * hosts.toml) that cannot address it.
 *
 * Nothing matches on the bare word "sandbox": `FailedCreatePodSandBox` is
 * also what kubelet reports when the CNI cannot wire a pod up, and sending
 * a CNI-broken node to the runsc repair helps no one. Unrecognized is a
 * better answer than confidently wrong — it lands as unverified on every
 * gate, which is visible and true.
 */
function blameProbeFailure(event: string): ProbeBlame {
  if (/FailedMount|MountVolume|hostPath/i.test(event)) return 'volume'
  if (/RuntimeClass|runsc|no runtime for/i.test(event)) return 'runsc'
  if (/ImagePull|ErrImage|pull|manifest unknown|no such host|connection refused/i.test(event)) {
    return 'registry'
  }
  return 'unknown'
}

/**
 * One pinned probe pod on one node, mirroring what a worktree asks of the
 * node it lands on: pull the image from the registry (`Always`, so a
 * cached copy cannot mask an unreachable registry), run on the gvisor
 * RuntimeClass, and read *and write* the shared data dir at the worktree
 * uid through the gofer.
 *
 * `nodeName` rather than a nodeSelector: this is a per-node question, and
 * bypassing the scheduler is what makes the answer about the node instead
 * of about where the scheduler felt like putting the pod. Bypassing the
 * scheduler is not bypassing kubelet, though — a `NoExecute` taint evicts a
 * pod that does not tolerate it however it got bound — which is why the pod
 * names the gvisor RuntimeClass and inherits its tolerations along with its
 * handler, exactly as a worktree pod does. Nothing here declares a toleration
 * of its own: a probe that tolerated more than a worktree would report a node
 * as usable that no worktree can reach.
 */
async function probeNode(
  node: ClusterNode,
  index: number,
  ctx: { imageRef: string; nonce: string; dataDir: string },
): Promise<NodeProbeOutcome> {
  const marker = `.cluster-check-node-${index}`
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
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: ctx.imageRef,
          imagePullPolicy: 'Always',
          securityContext: { runAsUser: podUid() },
          command: [
            'sh', '-c',
            'dmesg 2>/dev/null | grep -qi gvisor && echo GVISOR_SANDBOXED; '
            + `cat /probe/${NODE_PROBE_NONCE_FILE} && echo ok > /probe/${marker}`,
          ],
          volumeMounts: [{ name: 'probe', mountPath: '/probe' }],
        }],
        volumes: [{ name: 'probe', hostPath: { path: ctx.dataDir, type: 'Directory' } }],
      },
    }, {
      // Shorter than the e2e probe's: these run one per node, and a pinned
      // pod that has not started inside a minute is stuck on something this
      // reports (an image it cannot pull, a runtime it cannot find) rather
      // than merely slow.
      timeoutMs: 60_000,
      kubectl: (args) => execFileAsync('kubectl', args),
      apply: kubectlApply,
    })
    outcome.phase = phase
    outcome.sandboxed = logs.includes('GVISOR_SANDBOXED')
    outcome.sawNonce = logs.includes(ctx.nonce)
    outcome.wroteMarker = (await fs.readFile(path.join(ctx.dataDir, marker), 'utf8')
      .catch(() => '')).trim() === 'ok'
    if (phase !== 'Succeeded') {
      outcome.failureHint = await podFailureEvent(podName)
      outcome.blame = blameProbeFailure(outcome.failureHint)
    }
    return outcome
  } catch {
    return outcome
  } finally {
    await fs.rm(path.join(ctx.dataDir, marker), { force: true })
      .catch(() => { /* best-effort */ })
  }
}

const REGISTRY_NODES_FIX =
  'Each node pulls session images itself, so every node needs the registry '
  + 'wiring: the containerd `hosts.toml` mapping and the registry container '
  + 'on the kind network. `yaac cluster install` re-applies both on '
  + 'every node.'

const VOLUME_NODES_FIX =
  'Session pods mount worktrees, caches and credentials by hostPath, which '
  + 'resolves on the NODE. Every node therefore needs the home-directory '
  + 'extraMount — `yaac cluster install --nodes N` renders it onto every node '
  + 'it creates, so a cluster made by hand (or by an older yaac) is the '
  + 'usual cause.'

/** Node names for a warn detail, capped so a wide cluster stays readable. */
function nodeList(names: string[]): string {
  return names.slice(0, 4).join(', ') + (names.length > 4 ? ` (+${names.length - 4} more)` : '')
}

/**
 * The multi-node readiness sweep: for each node a worktree could actually
 * land on, does that node have the three things a worktree needs?
 *
 *  - **runsc-nodes** — the gvisor RuntimeClass is accepted there. Three
 *    sources, cheapest first: a worktree-capable node the installer
 *    DaemonSet has not labelled cannot even be scheduled a sandboxed pod,
 *    which is the DaemonSet's own not-converged-here signal; otherwise a
 *    node whose kubelet publishes `status.runtimeHandlers` is judged by
 *    that; otherwise by its probe pod, since containerd refuses a pod whose
 *    handler it never registered. The `gvisor` gate above proves the
 *    handler really is the sentry, and that SOME node carries the label —
 *    how many is this gate's question.
 *  - **registry-nodes** — that node's containerd can pull from the local
 *    registry (the probe pulls `Always`).
 *  - **volume-nodes** — the shared data dir hostPath resolves to the same
 *    bytes the server sees, and the worktree uid can write it.
 *
 * A pod that never runs is attributed to ONE of them from the kubelet's
 * event (blameProbeFailure) and left *unverified* — never passed — on the
 * others: the three failures are indistinguishable from the pod phase
 * alone, and the whole value of splitting them is that each carries the
 * repair for its own cause.
 *
 * Every gate's detail carries what the sweep did NOT cover — the nodes no
 * worktree can land on, each with its reason. A sweep that narrows silently
 * is worse than one that does not narrow: a node that dropped out under a
 * transient pressure taint, or a joining node still carrying kubelet's
 * `uninitialized` taint, would otherwise be invisible behind an "all N
 * worktree-eligible nodes" pass.
 *
 * Warn-level throughout, and skipped on a single-node cluster where the
 * `gvisor`, `probe` and `egress` gates already cover the only node: this
 * exists to catch the topology drift a multi-node cluster introduces, not
 * to re-litigate what the single-node gates decided.
 */
async function runMultiNodeReadiness(
  nodes: ClusterNode[],
  gvisorScheduling: GvisorScheduling,
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

  // Two different populations, and conflating them is how this gate would
  // miss the very thing it is for. `worktreeCapable` is where a worktree
  // could run if the runtime were there — Ready, uncordoned, and carrying no
  // taint the gvisor RuntimeClass's tolerations fail to cover.
  // `eligible` narrows that to where a sandboxed pod can be SCHEDULED
  // today: the RuntimeClass's nodeSelector matches the label the installer
  // DaemonSet stamps once it has converged on a node. So a worktree-capable
  // node OUTSIDE the selector is not out of scope — it is precisely a node
  // the runtime has not reached, which is a runsc-nodes finding, not a
  // reason to stop reporting on it.
  const worktreeCapable = nodes.filter((n) => n.ready && n.schedulable)
  const eligible = worktreeCapable.filter((n) =>
    Object.entries(nodeSelector).every(([k, v]) => n.labels[k] === v))
  const unlabelled = worktreeCapable.filter((n) => !eligible.includes(n))

  // What the sweep is NOT reporting on, carried into every gate's detail.
  // Narrowing to the nodes a worktree can use is right; doing it silently is
  // not — "all 2 worktree-eligible nodes pulled" on a three-node cluster
  // reads as full coverage whether the third node is a control plane or a
  // worker that just picked up a disk-pressure taint.
  const skipped = [
    ...nodes.filter((n) => !n.ready).map((n) => `${n.name} (NotReady)`),
    ...nodes.filter((n) => n.ready && !n.schedulable)
      .map((n) => `${n.name} (${n.excludedBecause})`),
  ]
  const skippedTail = skipped.length > 0
    ? `; not swept: ${nodeList(skipped)}`
    : ''

  if (worktreeCapable.length === 0) {
    return uniform(
      'warn',
      `no node can schedule a session (see the nodes check above): ${nodeList(skipped)}`,
    )
  }
  if (eligible.length === 0) {
    return uniform(
      'warn',
      `no session-capable node satisfies the ${RUNTIME_CLASS_GVISOR} RuntimeClass `
      + `nodeSelector, so nothing can be probed: ${nodeList(worktreeCapable.map((n) => n.name))}`
      + skippedTail,
      gvisorFix(),
    )
  }

  const dataDir = sharedRoot()
  const nonce = crypto.randomUUID()
  const nonceFile = path.join(dataDir, NODE_PROBE_NONCE_FILE)
  try {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(nonceFile, nonce)
    const imageRef = await ensureProbeImage()
    const outcomes = await Promise.all(eligible.map((node, i) =>
      probeNode(node, i, { imageRef, nonce, dataDir })))

    const ran = new Map(outcomes.map((o) => [o.node, o]))
    const failed = outcomes.filter((o) => o.phase !== 'Succeeded')
    const withCause = (o: NodeProbeOutcome): string =>
      `${o.node} (${o.failureHint || o.phase})`

    // Per node, not per cluster: a node whose kubelet publishes the handler
    // list is judged by it, and one that publishes nothing (an older
    // kubelet beside a newer one) falls back to its own pod outcome. A
    // cluster-wide "someone published, so everyone is judged by the field"
    // would flag the silent node as missing runsc while its probe ran fine.
    const runscVerdict = (n: ClusterNode): 'ok' | 'missing' | 'unknown' => {
      if (handler !== '' && n.runtimeHandlers.length > 0) {
        return n.runtimeHandlers.includes(handler) ? 'ok' : 'missing'
      }
      const o = ran.get(n.name)
      if (o?.phase === 'Succeeded') return 'ok'
      return o?.blame === 'runsc' ? 'missing' : 'unknown'
    }

    const sentryVerified = outcomes.filter((o) => o.sandboxed).length
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
        // No fix: the gate that owns the failure carries it, and repeating
        // an unrelated one here is how a user gets sent to the wrong repair.
        return {
          name, status: 'warn',
          detail: `unverified on ${nodeList(unverified)} — their probe pod did not run `
            + '(the cause is reported by whichever of the *-nodes gates owns it)'
            + skippedTail,
        }
      }
      return { name, status: 'pass', detail: passDetail + skippedTail }
    }

    // A worktree-capable node the installer has not labelled cannot host a
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
        `${RUNTIME_CLASS_GVISOR} accepted on all ${worktreeCapable.length} session-capable `
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
              ? `uid ${podUid()} write did not reach the host`
              : 'stale or absent mount'})`),
        ],
        [...failed.filter((o) => o.blame !== 'volume').map((o) => o.node), ...unlabelledNames],
        VOLUME_NODES_FIX,
        (list) => `${sharedRoot()} is not the server's on: ${list}`,
        `shared data dir visible and writable at uid ${podUid()} from all `
          + `${eligible.length} session-eligible nodes`,
      ),
    ]
  } catch (err) {
    return uniform('warn', `multi-node readiness sweep errored (${truncate(err)})`)
  } finally {
    await fs.rm(nonceFile, { force: true }).catch(() => { /* best-effort */ })
  }
}

const NETPOL_PROBE_POD_NAME = 'yaac-cluster-check-egress'

/**
 * Verify the CNI actually enforces the worktree egress NetworkPolicy. A
 * policy on a non-enforcing CNI silently fails OPEN — worktrees would have
 * unrestricted egress and the proxy allowlist would be advisory. The
 * probe pod carries the worktree-id label (so the policy selects it; it
 * stays invisible to listWorktreePods, which also filters on this
 * install's data-dir-hash) and tries to reach the kube-apiserver's
 * ClusterIP — always present, always reachable in the absence of policy,
 * and addressed by IP so the verdict does not depend on DNS.
 */
async function runNetworkPolicyProbe(): Promise<CheckResult> {
  const ns = k8sNamespace()
  try {
    // The cluster-level egress lockdown: the worktree NetworkPolicy admits
    // world-ward egress ONLY to the node's netd listener range, so a pod
    // cannot address the internet directly and cannot dial the proxy's
    // transparent ports at all — those are admitted from the node CIDRs
    // only (netd's Envoy is the sole legitimate caller, and the sole
    // originator of PROXY-protocol preambles).
    const nodeCidrs = await nodeIpBlocks()
    await kubectlApply(buildWorktreeEgressNpManifest(nodeCidrs))
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

    // When the proxy is deployed, also assert the forgery lock from the
    // same worktree-labeled pod: it must NOT be able to dial a transparent
    // port directly. The block is on the pod's own egress (the worktree
    // policy's default-deny above), not the proxy ingress. A direct connect that
    // SUCCEEDS would let a pod inject a forged PROXY-protocol source and
    // impersonate another worktree. Absent proxy → skip this half (it deploys
    // lazily on the first worktree create).
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

    // Third leg, same pod: the registry is unauthenticated with mutable
    // tags and no path ACLs, so "a worktree cannot reach it" is a security
    // property and worth asserting rather than assuming. Addressed by
    // ClusterIP, not by name — a DNS failure would otherwise read as a
    // pass. Absent Service → skip (nothing to reach).
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

    // Fourth leg, same pod: the SERVER. On a local install the API is
    // credential-optional and the server pod binds 0.0.0.0, so the ingress
    // NetworkPolicy — everything EXCEPT the pod CIDRs — is the entire wall
    // between an untrusted worktree and an unauthenticated control plane
    // (docs/server-in-cluster.md). That makes it exactly the kind of
    // property to PROVE on every install rather than assume was applied,
    // like the apiserver and forgery-lock denials above. Absent Service →
    // this cluster has not been converged yet (or was created before the
    // server was published through it), so there is nothing to reach and
    // nothing to prove; install is what puts one there.
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

    const imageRef = await pushImageToRegistry(PROBE_LOCAL_TAG)
    const { phase, logs } = await runPodToCompletion({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: NETPOL_PROBE_POD_NAME,
        namespace: ns,
        labels: worktreeIdLabels('cluster-check-egress-probe'),
      },
      spec: {
        restartPolicy: 'Never',
        // The gvisor tier, like the real worktree pods this probe stands in
        // for — so the verdict also covers policy enforcement on netstack
        // traffic (the egress model is host-side/veth-level and must hold
        // regardless of the pod's runtime).
        runtimeClassName: RUNTIME_CLASS_GVISOR,
        containers: [{
          name: 'probe',
          image: imageRef,
          command: [
            'sh', '-c',
            `nc -w 4 ${apiserverIp} 443 </dev/null && echo NP_REACHED || echo NP_BLOCKED`
            + proxyCheck + registryCheck + serverCheck,
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
          + 'policy engine.\nOn a cluster whose CNI yaac adopted '
          + '(`--adopt-cni`), this is the probe that says the adopted engine '
          + 'is not actually enforcing plain networking.k8s.io/v1 policy — '
          + '"Calico is installed" does not imply it. Policy-only Calico over '
          + 'a foreign IPAM needs its policy plane genuinely wired up.',
      }
    }
    if (logs.includes('NP_REGISTRY_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the image registry directly — it is '
          + 'unauthenticated with mutable tags, so any session could overwrite any image',
        fix: 'Session egress must default-deny everything but the node\'s netd '
          + 'listener range, and the registry admits only the node and builder '
          + 'pods. Restart the yaac server so both policies are re-applied.',
      }
    }
    if (logs.includes('NP_SERVER_OPEN')) {
      return {
        name: 'egress', status: 'fail',
        detail: 'a session-labeled pod reached the yaac server directly — on a '
          + 'local install its API is credential-optional, so any session could '
          + 'drive the control plane that manages every other one',
        fix: 'The server-ingress NetworkPolicy must admit the server port from '
          + 'everything EXCEPT the pod CIDRs, so a pod dialing the Service or '
          + 'pod IP is dropped while NodePort traffic is not. Not the node '
          + 'CIDRs: kube-proxy masquerades in POSTROUTING, after the filter '
          + 'hook, so policy sees the original off-cluster source. Re-run '
          + '`yaac cluster install`, which applies it with the Deployment.',
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
    if (logs.includes('NP_BLOCKED')) {
      // Both extra legs are skipped when their target is absent, so the
      // clauses are COMPOSED rather than concatenated: appending a bare
      // ", nor the image registry" after the "proxy not deployed"
      // parenthetical leaves a sentence with nothing for the "nor" to
      // continue.
      const denied: string[] = []
      if (proxyIp) denied.push('a transparent port directly (forgery lock holds)')
      if (registryIp) denied.push('the image registry')
      if (serverIp) denied.push('the yaac server')
      const deniedHalf = denied.length ? `, and cannot dial ${denied.join(', nor ')}` : ''
      const unverified: string[] = []
      if (!proxyIp) unverified.push('proxy not deployed — forgery-lock half unverified')
      if (!registryIp) unverified.push('registry not deployed — that half unverified')
      if (!serverIp) unverified.push('server not deployed in-cluster — that half unverified')
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

/**
 * `container: reason` for every not-ready netd container, from
 * `kubectl get pods -o json`. Unparseable input yields nothing — this only
 * ever enriches a failure that has already been decided.
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
 * The datapath gate: Calico must be enforcing, and netd must be up with
 * its redirect chain programmed.
 *
 * These are the two components worktree egress depends on, and they fail in
 * opposite directions — which is why both are checked. Calico missing means
 * NO policy enforcement, so the whole egress lockdown is advisory (the
 * behavioural half of that is the `egress` probe above). netd missing means
 * no redirect at all, which is fail-CLOSED: worktrees simply lose egress.
 * A user staring at "every worktree lost the internet" needs to be told
 * which of the two it is.
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
          + '(or `--adopt-cni` on a cluster whose Calico yaac did not install), '
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
      // Which container is unhealthy is the whole diagnosis here: netd's
      // readiness is Envoy's config ack, so a broken Envoy sidecar reads
      // exactly like a broken netd from the DaemonSet's counters alone.
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
 * The pod → veth gate. Reads every netd pod's own node routing table and
 * applies the same verdict `--adopt-cni` applies (assessVethSource), so
 * setup and check cannot disagree about what a working redirect source
 * looks like.
 *
 * Cheap: one `kubectl exec` per node into a container that is already
 * running, no pod to schedule.
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
 * Warn-level gate for nestedContainers worktrees (the rootful in-sandbox
 * engine). Reproduces the core sentry prerequisite the engine depends on,
 * under the real nested containment (gvisor-nested + the engine's in-sandbox
 * caps, no userns): the in-sandbox root must be able to `mount` (SYS_ADMIN
 * honored under the sentry) — every container start and `docker build` RUN
 * does overlay/proc/tmpfs mounts. A cluster whose runsc-nested handler is
 * broken (or absent) fails to start the pod at all. The richer prerequisites
 * the engine also needs — `allow-suid` for the `sudo`-started service, file
 * caps on the tmpfs graphroot — are verified end to end by the
 * nested-containers e2e;
 * this probe stays busybox-simple (no sudo/setcap in the probe image).
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
        // The nested tier: gvisor-nested, no userns — the sentry is the
        // containment (mirrors buildPodJobManifest's nested+gvisor path).
        runtimeClassName: RUNTIME_CLASS_GVISOR_NESTED,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'probe',
          image: imageRef,
          // Run as in-sandbox root (the rootful engine's shape) with its
          // in-sandbox caps; SYS_ADMIN is what mount() needs.
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
 * `ensureBuilderRoleGuard` refuses to apply without the API (fail-closed,
 * no opt-out) — so an install that lacks it cannot build an image at all.
 * Probes via `vapAvailable`, the exact gate the guard applies, so check
 * and gate cannot drift.
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
      + 'default) and fail closed without it, so no worktree image can '
      + 'be built. This needs a newer cluster: `yaac cluster delete`, '
      + 'then `yaac cluster install`.',
  }
}

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg.split('\n')[0]
}
