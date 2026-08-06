import {
  NETD_APP_NAME,
  RUNTIME_CLASS_GVISOR,
  isKubectlAbsentError,
  k8sNamespace,
  kubectlErrorSummary,
  untoleratedTaints,
} from '#platform/k8s'
import type { NodeTaint, PodToleration } from '#platform/k8s'
import type { execFileAsync } from '#platform/k8s'
import { env } from '@yaac/shared/env'
import { podCidrSources } from './cluster-cidrs'

/**
 * Adopting a CNI yaac did not install.
 *
 * `yaac cluster setup` normally owns the CNI: it creates the cluster with
 * no default CNI and applies a checksum-pinned Calico. `--adopt-cni` skips
 * that and runs this gate instead, so yaac can install into a Calico the
 * cluster already runs — our own, a self-managed one, or a
 * provider-managed one (GKE Dataplane V1, AKS `--network-policy calico`,
 * Calico policy-only over the AWS VPC CNI on EKS).
 *
 * **The gate is the point of the mode.** There is no datapath change here:
 * the netd redirect (docs/session-egress.md) works unmodified on any CNI
 * that traverses host netfilter and leaves ClusterIP translation to
 * kube-proxy. What changes is that four things yaac otherwise ASSUMES
 * become things it DETECTS — and every one of them fails silently when the
 * assumption is wrong. An unverified adoption presents as "sessions have
 * no egress" or, worse, as a redirect chain that counts packets and never
 * fires. So each check below refuses with the specific reason rather than
 * warning and proceeding.
 *
 * Cilium is out of scope in every configuration: its eBPF host-routing
 * short-circuits the netfilter hook the redirect needs. The eBPF checks
 * here exist because Calico's own eBPF dataplane does exactly the same
 * thing, and unlike Cilium it can be turned on under a Calico install that
 * otherwise looks adoptable.
 */

/**
 * Interface-name prefix Calico gives every workload veth — the default
 * when nothing is configured. Deliberately duplicated from
 * `k8s/netd/routes.ts` (`DEFAULT_VETH_PREFIX`) rather than shared: netd is
 * its own package built into a container image and the server cannot
 * import it, which is the same reason netd re-declares the transparent
 * port numbers as env defaults.
 */
export const DEFAULT_VETH_PREFIX = 'cali'

/**
 * The veth prefix netd is told to match on: the operator's configured
 * value, else Calico's. `--adopt-cni` verifies the result against the
 * node's real routing table, which is what turns a wrong value into a
 * refusal instead of a cluster whose sessions silently have no egress.
 */
export function cniVethPrefix(): string {
  return env.cniVethPrefix ?? DEFAULT_VETH_PREFIX
}

/** Everything the gate reads about the cluster's CNI, in one shape. */
export interface CniFacts {
  /**
   * calico-node: the DaemonSet's own report of how far it has rolled out.
   * `present` is a three-way answer — `null` means the read failed, which
   * is not the same claim as "the cluster has no Calico" and must not be
   * reported as one.
   */
  calico: { present: boolean | null; ready: number; desired: number }
  felix: {
    /**
     * `spec.bpfEnabled` across EVERY FelixConfiguration, not just `default`
     * — Felix honors per-node overrides (`node.<nodename>` objects), so a
     * cluster whose `default` leaves it unset and whose per-node object
     * turns it on is still an eBPF cluster. Null when nothing sets it.
     */
    bpfEnabled: boolean | null
    /**
     * `FELIX_BPFENABLED` on the calico-node container; null when unset.
     * `'unevaluable'` when the entry exists but carries no literal value
     * (a `valueFrom` ConfigMap/fieldRef reference), which is not the same
     * claim as "off".
     */
    bpfEnabledEnv: boolean | 'unevaluable' | null
    /** `spec.chainInsertMode`; null when unset (Felix defaults to Insert). */
    chainInsertMode: string | null
    /** `spec.bpfKubeProxyIptablesCleanupEnabled`; null when unset. */
    bpfKubeProxyIptablesCleanupEnabled: boolean | null
    /**
     * False when the read failed. Nothing about Felix may then be
     * RECORDED either — "Insert (Felix default — nothing sets it)" is a
     * claim about the cluster, and an audit trail that states one the gate
     * never established is worse than one that says nothing.
     */
    evaluated: boolean
  }
  /**
   * kube-proxy, counted from its pods so a static-pod install still counts,
   * and per-node because a node without one loses session egress on that
   * node alone. `external` is the operator's acknowledgement that it runs
   * where no pod can be found (k3s runs it in-process).
   */
  kubeProxy: {
    pods: number
    running: number
    nodes: string[]
    external: boolean
    /** False when the read failed — "none running" was never established. */
    evaluated: boolean
  }
  /** Every node a session could land on — the per-node coverage denominator. */
  schedulableNodes: string[]
  /** The three sources netd's redirect exclusion set unions, plus rejects. */
  podCidrs: {
    configured: string[]
    pools: string[]
    nodes: string[]
    droppedConfigured: string[]
    /** Sources whose read failed — see `unevaluated`. */
    unreadable: Array<{ source: string; cause: string }>
  }
  /**
   * netd names this PriorityClass; a pod naming a missing class is
   * rejected. `null` when the read failed — see `calico.present`.
   */
  systemNodeCriticalPresent: boolean | null
  /** What netd will be told to match workload veths on. */
  vethPrefix: string
  /**
   * Checks that could not be EVALUATED — a read that failed for any reason
   * other than the object genuinely being absent (RBAC, a timeout, an
   * unparseable response).
   *
   * This is the difference between a fact and an unknown, and it is
   * load-bearing in exactly one direction. For the checks where absence
   * refuses (calico-node, kube-proxy, the PriorityClass), collapsing an
   * error into "absent" is safe — it refuses either way. For the eBPF check
   * it INVERTS: absence means "Felix runs its iptables defaults", so a
   * FelixConfiguration read that failed would wave an eBPF cluster through
   * and land as silent no-egress, which is the exact failure this gate
   * exists to convert into a named refusal. So an unevaluated check is a
   * refusal of its own — reported as `{check, cause}` so the assessment can
   * group several checks defeated by one problem.
   */
  unevaluated: Array<{ check: string; cause: string }>
}

/**
 * The verdict. `refusals` is non-empty exactly when the adoption must not
 * proceed; `warnings` are things the operator should know that do not
 * break the datapath; `notes` are what the verification RECORDED, which is
 * the audit trail for a cluster yaac does not own.
 */
export interface CniAssessment {
  refusals: string[]
  warnings: string[]
  notes: string[]
}

/**
 * Judge the gathered facts. Pure — every cluster read happens in
 * `gatherCniFacts`, so the whole refusal policy is decided by data and can
 * be reasoned about (and driven) without a cluster.
 */
export function assessCniAdoption(facts: CniFacts): CniAssessment {
  const refusals: string[] = []
  const warnings: string[] = []
  const notes: string[] = []

  // 1. Calico present at all. This is also the Cilium refusal in practice:
  //    a Cilium cluster has no calico-node, and there is no configuration
  //    of Cilium the veth-peer redirect survives.
  // Throughout: a check whose read FAILED emits no absence-shaped refusal.
  // The unevaluated refusal at the end already names it, and asserting an
  // absence the gate never established is a second diagnosis pointing at
  // the wrong fix — "no calico-node in kube-system" reads as a Cilium
  // cluster when the truth is an unreachable apiserver.
  if (facts.calico.present === null) {
    // Reported by the unevaluated refusal below.
  } else if (!facts.calico.present) {
    refusals.push(
      'no calico-node found in kube-system. yaac\'s egress redirect is a nat DNAT at '
      + 'each pod\'s host-side veth, so it needs a CNI whose pod egress traverses host '
      + 'netfilter and which leaves ClusterIP translation to kube-proxy — Calico in its '
      + 'iptables dataplane, self-managed or provider-managed. Cilium is not supported '
      + 'in any configuration (its eBPF host-routing bypasses the hook the redirect '
      + 'needs). Drop --adopt-cni to have yaac install its own pinned Calico.',
    )
  } else if (!(facts.calico.ready > 0) || facts.calico.ready !== facts.calico.desired) {
    refusals.push(
      `calico-node is ${facts.calico.ready}/${facts.calico.desired} ready — NetworkPolicy `
      + 'is not being enforced on every node, and session egress lockdown is the policy '
      + 'plane, not netd. Wait for the rollout (`kubectl -n kube-system rollout status '
      + 'daemonset/calico-node`) and re-run.',
    )
  }

  // 2. The iptables dataplane, HARD. Calico's eBPF dataplane bypasses
  //    iptables for pod traffic exactly the way Cilium does: the redirect
  //    chain would be programmed, count nothing, and never fire — a
  //    failure with no symptom but "sessions cannot reach the internet".
  const bpf = facts.felix.bpfEnabled === true || facts.felix.bpfEnabledEnv === true
  if (bpf) {
    const where = facts.felix.bpfEnabled === true
      ? 'a FelixConfiguration sets spec.bpfEnabled'
      : 'FELIX_BPFENABLED on the calico-node container is'
    refusals.push(
      `Calico is running its eBPF dataplane (${where} true). eBPF host-routing `
      + 'short-circuits host netfilter, so netd\'s nat DNAT at the veth peer would never '
      + 'see pod egress — the redirect chain exists, counts zero packets, and every '
      + 'session silently loses the internet. Switch Calico to the iptables dataplane '
      + '(`kubectl patch felixconfiguration default --type=merge -p \'{"spec":'
      + '{"bpfEnabled":false}}\'`, and check for per-node `node.<name>` overrides) and '
      + 're-run.',
    )
  } else if (facts.felix.bpfEnabledEnv === 'unevaluable') {
    // The entry exists but its value comes from a ConfigMap or fieldRef, so
    // the manifest does not say what the dataplane is. "No literal value"
    // is not the same claim as "off", and guessing off is the direction
    // that ends in silent no-egress.
    refusals.push(
      'the calico-node container sets FELIX_BPFENABLED from a `valueFrom` reference, so '
      + 'this cannot tell whether Calico is in its eBPF dataplane — and eBPF would make '
      + 'the redirect count zero packets forever. Resolve the reference and confirm the '
      + 'iptables dataplane (`kubectl get felixconfiguration default -o '
      + 'jsonpath=\'{.spec.bpfEnabled}\'`), then set it to a literal value or unset it.',
    )
  }

  // 3. kube-proxy. netd's Envoy dials the yaac proxy's ClusterIP from the
  //    HOST netns; without kube-proxy there is nothing to translate that
  //    dial, and the redirect delivers into a black hole.
  if (facts.kubeProxy.external) {
    // Explicitly acknowledged: k3s runs kube-proxy in-process inside the
    // kubelet, so there is no pod, DaemonSet or label to find. Recorded
    // rather than silently accepted — this is the one check an operator can
    // wave through, and the audit trail should say they did.
    notes.push(
      'kube-proxy: declared external (YAAC_KUBE_PROXY_EXTERNAL=1) — not verified here. '
      + 'ClusterIP translation must still be kube-proxy\'s; if it is not, netd\'s Envoy '
      + 'cannot reach the proxy and sessions lose egress (they never gain it).',
    )
  } else if (!facts.kubeProxy.evaluated) {
    // Reported by the unevaluated refusal below.
  } else if (facts.kubeProxy.running === 0) {
    refusals.push(
      (facts.kubeProxy.pods === 0
        ? 'no kube-proxy pod found in kube-system (searched `k8s-app=kube-proxy` and '
          + '`component=kube-proxy`). netd\'s Envoy dials the yaac proxy by ClusterIP '
          + 'from the node\'s host network namespace, so a cluster whose kube-proxy has '
          + 'been replaced (by Calico\'s eBPF kube-proxy replacement or by Cilium) has '
          + 'nothing to translate that dial and the redirect delivers nowhere. Also: '
          + 'appending the redirect below kube-proxy\'s KUBE-SERVICES is what keeps '
          + 'ClusterIP traffic out of it.'
        : `kube-proxy has ${facts.kubeProxy.pods} pod(s) but none running — netd's Envoy `
          + 'cannot resolve the yaac proxy\'s ClusterIP from the host netns until it is up.')
      + (facts.kubeProxy.pods === 0
        ? '\n    If kube-proxy runs OUTSIDE a pod on this cluster — k3s runs it in-process '
          + 'inside the kubelet — confirm ClusterIP translation is still its job and '
          + 're-run with YAAC_KUBE_PROXY_EXTERNAL=1.'
        : ''),
    )
  } else {
    // Per-node, not per-cluster. One running kube-proxy proves the cluster
    // has one; it says nothing about the node a session actually lands on,
    // and a node without one loses egress by itself while the rest work.
    const uncovered = facts.schedulableNodes.filter((n) => !facts.kubeProxy.nodes.includes(n))
    if (uncovered.length > 0) {
      warnings.push(
        `no running kube-proxy on ${uncovered.length} session-capable node(s): `
        + `${uncovered.slice(0, 4).join(', ')}${uncovered.length > 4 ? ', …' : ''}. `
        + 'Sessions scheduled there lose egress — netd\'s Envoy cannot resolve the yaac '
        + 'proxy\'s ClusterIP from those nodes\' host netns — while every other node works, '
        + 'which reads as intermittent rather than broken.',
      )
    }
  }
  if (facts.felix.bpfKubeProxyIptablesCleanupEnabled === true) {
    refusals.push(
      'Calico is configured to clean up kube-proxy\'s iptables rules '
      + '(FelixConfiguration.spec.bpfKubeProxyIptablesCleanupEnabled), which means it is '
      + 'replacing kube-proxy. netd needs kube-proxy to own ClusterIP DNAT.',
    )
  }

  // 4. chainInsertMode: recorded, not enforced. netd APPENDS its jump to
  //    nat PREROUTING and never competes with Felix for position, so the
  //    design is safe either way — but which mode the adopted Calico runs
  //    changes where Felix's own jumps land relative to ours, and that is
  //    worth having in the record when a datapath question comes up later.
  const insertMode = facts.felix.chainInsertMode ?? 'Insert'
  if (facts.felix.evaluated) {
    notes.push(
      `Calico chainInsertMode: ${insertMode}`
      + (facts.felix.chainInsertMode === null
        ? ' (Felix default — no FelixConfiguration sets it)'
        : ''),
    )
  }
  if (facts.felix.evaluated && insertMode.toLowerCase() === 'append') {
    warnings.push(
      'Calico is in Append chainInsertMode. netd appends its own nat PREROUTING jump and '
      + 'terminates nothing it does not own, so the redirect is unaffected — but Calico is '
      + 'no longer guaranteeing itself the top of the base chains, so anything else on '
      + 'these nodes writing netfilter rules can now land above Felix.',
    )
  }

  // 5. The redirect exclusion set. Too NARROW is the dangerous direction:
  //    a pod IP outside the list is treated as world and its pod-to-pod
  //    443/80 is DNAT'd into the proxy.
  const { configured, pools, nodes, droppedConfigured } = facts.podCidrs
  const all = [...new Set([...configured, ...pools, ...nodes])].sort()
  if (droppedConfigured.length > 0) {
    // Refuse rather than drop. A typo'd entry that merely vanished would
    // leave the exclusion set narrower than what the operator wrote, and
    // they would have no way to tell: the recorded list shows only what
    // survived. Narrower means those pods' 443/80 goes into the proxy.
    refusals.push(
      `YAAC_POD_CIDRS contains ${droppedConfigured.length} entr(y/ies) that are not usable `
      + `IPv4 CIDRs: ${droppedConfigured.join(', ')}. Every octet must be 0-255 and the `
      + 'mask 0-32 — these become `-d <cidr>` lines in netd\'s iptables-restore document, '
      + 'which rejects the whole document on one bad line. Dropping them silently would '
      + 'leave the redirect exclusion set narrower than you configured it.',
    )
  }
  if (all.length === 0 && facts.podCidrs.unreadable.length > 0) {
    // Reported by the unevaluated refusal below: "the cluster publishes
    // none" is not something a failed read established.
  } else if (all.length === 0) {
    refusals.push(
      'no pod CIDR could be resolved: the cluster publishes no Calico IPPool and no node '
      + 'spec.podCIDR. netd excludes those CIDRs from the redirect, and with none it '
      + 'would DNAT pod-to-pod 443/80 into the proxy. Set YAAC_POD_CIDRS to the range(s) '
      + 'this cluster allocates pod IPs from (comma-separated) and re-run.',
    )
  } else {
    notes.push(`pod CIDRs (redirect exclusions): ${all.join(', ')}`)
    if (configured.length > 0) {
      notes.push(`  from YAAC_POD_CIDRS: ${configured.join(', ')}`)
    }
    if (pools.length === 0 && configured.length === 0) {
      // Node spec.podCIDR alone describes the kubeadm allocation, which a
      // foreign IPAM may simply not use.
      warnings.push(
        'the only pod-CIDR source is node spec.podCIDR — no Calico IPPool answered. That '
        + 'field describes the kubeadm allocation, which a foreign IPAM (a VPC CNI, for '
        + 'instance) does not use. If pods here get addresses outside it, set '
        + 'YAAC_POD_CIDRS to the real range(s): a pod IP outside the list is treated as '
        + 'world and redirected into the proxy.',
      )
    }
  }

  // 6. Namespace privilege and scheduling. netd is hostNetwork +
  //    NET_ADMIN/NET_RAW at system-node-critical with a blanket
  //    toleration; on a cluster we do not own, none of that is a given.
  if (facts.systemNodeCriticalPresent === null) {
    // Reported by the unevaluated refusal below.
  } else if (!facts.systemNodeCriticalPresent) {
    refusals.push(
      'the built-in system-node-critical PriorityClass is missing. netd names it, and the '
      + 'apiserver rejects a pod naming a class it does not have — which for a DaemonSet '
      + 'means no netd pod is ever created and no session gets a redirect.',
    )
  }

  notes.push(`workload veth prefix: ${facts.vethPrefix}*`)
  notes.push(
    'install, registry and vcluster namespaces labelled for the privileged Pod Security '
    + 'Standard (netd is hostNetwork with NET_ADMIN/NET_RAW, which baseline forbids) — '
    + 'namespace-scoped, so this relaxes nothing outside the namespaces yaac creates',
  )

  // 7. Anything that could not be evaluated. Last, so the refusals above —
  //    which name a concrete problem — lead. A read that failed is not
  //    evidence of a healthy cluster, and for the eBPF check specifically
  //    treating it as one is how an eBPF cluster gets waved through.
  if (facts.unevaluated.length > 0) {
    // Grouped by cause, because the common case is ONE problem (an
    // unreachable apiserver, a missing RBAC rule) failing five reads —
    // and repeating its message five times buries the sentence that says
    // what to fix.
    const byCause = new Map<string, string[]>()
    for (const { check, cause } of facts.unevaluated) {
      byCause.set(cause, [...(byCause.get(cause) ?? []), check])
    }
    const grouped = [...byCause.entries()]
      .map(([cause, checks]) => `\n      ${checks.join(', ')}\n        → ${cause}`)
      .join('')
    refusals.push(
      `${facts.unevaluated.length} check(s) could not be evaluated:${grouped}\n\n`
      + '    These are refusals rather than warnings because the checks they belong to '
      + 'are not all fail-closed: absence of a FelixConfiguration legitimately means '
      + '"Felix runs its iptables defaults", so a read that merely FAILED would wave an '
      + 'eBPF cluster through and land as silent no-egress. Nothing above claims what '
      + 'this cluster contains — the gate did not get to look. An adoption needs '
      + 'cluster-read on kube-system, nodes, priorityclasses and the Calico CRDs.',
    )
  }

  return { refusals, warnings, notes }
}

interface RawDaemonSet {
  status?: { numberReady?: number; desiredNumberScheduled?: number }
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{ name?: string; env?: Array<{ name?: string; value?: string }> }>
      }
    }
  }
}

interface RawFelixConfigList {
  items?: Array<{
    metadata?: { name?: string }
    spec?: {
      bpfEnabled?: boolean
      chainInsertMode?: string
      bpfKubeProxyIptablesCleanupEnabled?: boolean
    }
  }>
}

interface RawPodList {
  items?: Array<{ spec?: { nodeName?: string }; status?: { phase?: string } }>
}

interface RawSchedulableNodeList {
  items?: Array<{
    metadata?: { name?: string }
    spec?: { unschedulable?: boolean; taints?: NodeTaint[] }
  }>
}

/**
 * What a sandboxed pod tolerates, read from the gvisor RuntimeClass — the
 * same source `cluster check` reads, since the RuntimeClass admission
 * controller is what merges `scheduling.tolerations` into every pod naming
 * the class. Empty on a cluster with no such class (a fresh adoption, before
 * the runtime is installed), which is the honest answer for a pod that
 * stamps none.
 */
async function sessionTolerations(run: typeof execFileAsync): Promise<PodToleration[]> {
  const rc = valueOf(await readJson<{
    scheduling?: { tolerations?: PodToleration[] }
  }>(run, ['get', 'runtimeclass', RUNTIME_CLASS_GVISOR, '-o', 'json']))
  return rc?.scheduling?.tolerations ?? []
}

/**
 * A cluster read that distinguishes "the object is not there" from "I could
 * not find out".
 *
 * Collapsing the two is the fail-open this gate cannot afford. Absence is a
 * FACT with meaning — no FelixConfiguration means Felix runs its iptables
 * defaults, which is what yaac wants — so an RBAC denial or a timeout that
 * read as absence would license exactly the eBPF cluster the gate exists to
 * refuse.
 */
type Read<T> =
  | { kind: 'found'; value: T }
  | { kind: 'absent' }
  | { kind: 'error'; message: string }

async function readJson<T>(run: typeof execFileAsync, args: string[]): Promise<Read<T>> {
  let stdout: string
  try {
    ({ stdout } = await run('kubectl', args))
  } catch (err) {
    // `isKubectlAbsentError` is shared with cluster-cidrs.ts's own reads, so
    // the two cannot disagree about what counts as a fact.
    if (isKubectlAbsentError(err)) return { kind: 'absent' }
    return { kind: 'error', message: kubectlErrorSummary(err) }
  }
  try {
    return { kind: 'found', value: JSON.parse(stdout) as T }
  } catch {
    // kubectl exited 0 with something that is not JSON. Not a fact about
    // the cluster — an unknown.
    return { kind: 'error', message: 'kubectl returned unparseable JSON' }
  }
}

/** The value if found, else null — for reads whose absence is meaningful. */
function valueOf<T>(read: Read<T>): T | null {
  return read.kind === 'found' ? read.value : null
}

/**
 * Felix's own notion of a true boolean in an env var, which is wider than
 * `true`/`1`: it lowercases and accepts the `yes`/`y`/`t`/`on` family too.
 * Anything not recognizably FALSE counts as true, so an unfamiliar spelling
 * costs the adoption a refusal rather than waving an eBPF cluster through.
 */
const FALSEY = new Set(['', 'false', 'f', 'no', 'n', '0', 'off'])

function felixBool(raw: string): boolean {
  return !FALSEY.has(raw.trim().toLowerCase())
}

/**
 * Everything `assessCniAdoption` judges, read from the cluster. Every
 * absent object is a fact rather than an error: a provider-managed Calico
 * serves no FelixConfiguration CR at all, which means Felix is running its
 * defaults — the iptables dataplane in Insert mode, exactly what yaac
 * needs.
 */
export async function gatherCniFacts(run: typeof execFileAsync): Promise<CniFacts> {
  const [calicoRead, felixRead, kubeProxyRead, priorityRead, nodeRead, cidrs, tolerations] =
    await Promise.all([
      readJson<RawDaemonSet>(run, [
        'get', 'daemonset', 'calico-node', '-n', 'kube-system', '-o', 'json',
      ]),
      // The whole LIST, not just `default`: Felix honors per-node overrides
      // (`node.<nodename>`), so a cluster whose default leaves bpfEnabled
      // unset and whose per-node object turns it on is an eBPF cluster.
      readJson<RawFelixConfigList>(run, [
        'get', 'felixconfigurations.crd.projectcalico.org', '-o', 'json',
      ]),
      // Both label conventions: kubeadm/EKS/kind stamp `k8s-app`, GKE and
      // AKS stamp `component`. A cluster with neither is either running
      // kube-proxy outside a pod (k3s, in-process) or not running it.
      readJson<RawPodList>(run, [
        'get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=kube-proxy', '-o', 'json',
      ]).then(async (byK8sApp) => {
        if (byK8sApp.kind === 'error') return byK8sApp
        if ((valueOf(byK8sApp)?.items ?? []).length > 0) return byK8sApp
        return readJson<RawPodList>(run, [
          'get', 'pods', '-n', 'kube-system', '-l', 'component=kube-proxy', '-o', 'json',
        ])
      }),
      readJson<unknown>(run, ['get', 'priorityclass', 'system-node-critical', '-o', 'json']),
      readJson<RawSchedulableNodeList>(run, ['get', 'nodes', '-o', 'json']),
      podCidrSources(),
      sessionTolerations(run),
    ])

  // An error is an UNKNOWN, not a fact. Named per check so the refusal says
  // which verification did not happen.
  const unevaluated: CniFacts['unevaluated'] = []
  const note = (check: string, read: Read<unknown>): void => {
    if (read.kind === 'error') unevaluated.push({ check, cause: read.message })
  }
  note('calico-node DaemonSet', calicoRead)
  note('Calico FelixConfiguration (the eBPF-dataplane check)', felixRead)
  note('kube-proxy pods', kubeProxyRead)
  note('system-node-critical PriorityClass', priorityRead)
  note('node list', nodeRead)
  // The pod-CIDR sources read through a different runner (kubectlGetJson),
  // and an RBAC denial scoped to just `ippools` would otherwise present as
  // "Calico publishes no pool" and narrow the exclusion set in silence.
  unevaluated.push(...cidrs.unreadable.map((u) => ({
    check: `pod-CIDR source: ${u.source}`, cause: u.cause,
  })))

  const calicoDs = valueOf(calicoRead)
  const felixItems = valueOf(felixRead)?.items ?? []
  const kubeProxyItems = valueOf(kubeProxyRead)?.items ?? []

  // Felix also takes its dataplane switch from the container env, which is
  // how an operator-less install turns eBPF on without any CR to read.
  const bpfEntry = (calicoDs?.spec?.template?.spec?.containers ?? [])
    .find((c) => c.name === 'calico-node')?.env
    ?.find((e) => e.name === 'FELIX_BPFENABLED')
  const bpfEnabledEnv = bpfEntry === undefined
    ? null
    // Present but sourced from a ConfigMap/fieldRef: the manifest does not
    // say what the dataplane is, and "no literal value" is not "off".
    : bpfEntry.value === undefined ? 'unevaluable' as const : felixBool(bpfEntry.value)

  const anyFelix = <T>(pick: (spec: NonNullable<RawFelixConfigList['items']>[number]['spec']) => T | undefined): T | null =>
    felixItems.map((f) => pick(f.spec)).find((v) => v !== undefined) ?? null

  return {
    calico: {
      present: calicoRead.kind === 'error' ? null : calicoRead.kind === 'found',
      ready: calicoDs?.status?.numberReady ?? 0,
      desired: calicoDs?.status?.desiredNumberScheduled ?? 0,
    },
    felix: {
      // ANY object enabling it makes the cluster eBPF, so this is an
      // or-reduce rather than a lookup of `default`.
      bpfEnabled: felixItems.some((f) => f.spec?.bpfEnabled === true)
        ? true
        : anyFelix((s) => s?.bpfEnabled),
      bpfEnabledEnv,
      chainInsertMode: anyFelix((s) => s?.chainInsertMode),
      bpfKubeProxyIptablesCleanupEnabled:
        felixItems.some((f) => f.spec?.bpfKubeProxyIptablesCleanupEnabled === true)
          ? true
          : anyFelix((s) => s?.bpfKubeProxyIptablesCleanupEnabled),
      evaluated: felixRead.kind !== 'error',
    },
    kubeProxy: {
      pods: kubeProxyItems.length,
      running: kubeProxyItems.filter((p) => p.status?.phase === 'Running').length,
      nodes: [...new Set(kubeProxyItems
        .filter((p) => p.status?.phase === 'Running')
        .map((p) => p.spec?.nodeName)
        .filter((n): n is string => !!n))],
      external: env.kubeProxyExternal,
      evaluated: kubeProxyRead.kind !== 'error',
    },
    // "Could a session land here?" — answered by the SAME per-taint
    // matching `cluster check`'s node inventory uses, against the same
    // tolerations, because this is the population per-node kube-proxy
    // coverage is measured against and a second definition would drift.
    //
    // Real matching rather than "carries no taint at all": a dedicated
    // sessions pool is built by tainting the pool and declaring the
    // matching toleration on the gvisor RuntimeClass, which the admission
    // controller merges into every pod naming the class. Under the blanket
    // rule such a pool reads as zero session-capable nodes, so the
    // kube-proxy coverage warning would silently check nothing at all —
    // the very shape it exists to catch.
    schedulableNodes: (valueOf(nodeRead)?.items ?? [])
      .filter((n) => n.spec?.unschedulable !== true
        && untoleratedTaints(n.spec?.taints, tolerations).length === 0)
      .map((n) => n.metadata?.name)
      .filter((n): n is string => !!n),
    podCidrs: cidrs,
    systemNodeCriticalPresent:
      priorityRead.kind === 'error' ? null : priorityRead.kind === 'found',
    vethPrefix: cniVethPrefix(),
    unevaluated,
  }
}

/** A dotted-quad `<ip> dev <iface> ... scope link` workload route. */
const WORKLOAD_ROUTE_RE =
  /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+(\S+)(?=\s).*\bscope link\b/

/**
 * What a node's routing table says about workload veths, for the prefix
 * netd will match on.
 *
 * Pure, and deliberately the same shape `k8s/netd/routes.ts` parses: this
 * is the verification that netd's ONE pod → veth source actually exists on
 * an adopted CNI. `suggestions` are the leading-alpha prefixes of the
 * per-workload routes that are there but do not match, so a wrong
 * `YAAC_CNI_VETH_PREFIX` can be reported as the value it should have been.
 */
export function assessWorkloadRoutes(
  ipRouteOutput: string,
  prefix: string,
): { matched: number; suggestions: string[] } {
  let matched = 0
  const suggestions = new Set<string>()
  for (const rawLine of ipRouteOutput.split('\n')) {
    const m = WORKLOAD_ROUTE_RE.exec(rawLine.trim())
    if (!m) continue
    const iface = m[2]
    if (iface.startsWith(prefix)) {
      matched += 1
      continue
    }
    // Only interfaces that look like a per-workload veth family are worth
    // suggesting: a node's own `eth0`/`lo` subnet routes are scope-link too,
    // but they carry no hash suffix. The alpha run is LAZY on purpose —
    // hex digits are also letters, so a greedy one turns `enia7b3c9d1e2f4`
    // into `enia` and hands the user a prefix that matches one veth.
    const family = /^([a-z]+?)[0-9a-f]{6,}$/.exec(iface)?.[1]
    if (family) suggestions.add(family)
  }
  return { matched, suggestions: [...suggestions].sort() }
}

/** One netd pod's answer about its own node's routing table. */
export interface NodeVethOutcome {
  node: string
  matched: number
  suggestions: string[]
  /** Set when the exec failed — unverified, which is not the same as zero. */
  error?: string
}

/**
 * Read the pod → veth source from EVERY netd pod, which is every node.
 *
 * Through netd itself because it is hostNetwork and ships iproute2, so its
 * `ip route` is the node's own. Per pod rather than `exec daemonset/...`,
 * which samples whichever pod kubectl picks: on a heterogeneous adopted
 * fleet (mixed node pools or AMIs — the realistic EKS shape) one node's
 * routing table says nothing about the others', and a node whose veths are
 * named differently is a node whose sessions get no redirect.
 */
export async function probeWorkloadVeths(
  run: typeof execFileAsync,
  prefix: string,
): Promise<NodeVethOutcome[]> {
  const pods = valueOf(await readJson<{
    items?: Array<{
      metadata?: { name?: string }
      spec?: { nodeName?: string }
      status?: { phase?: string }
    }>
  }>(run, [
    'get', 'pods', '-n', k8sNamespace(), '-l', `app=${NETD_APP_NAME}`, '-o', 'json',
  ]))?.items ?? []

  const running = pods.filter((p) => p.status?.phase === 'Running' && p.metadata?.name)
  return Promise.all(running.map(async (p): Promise<NodeVethOutcome> => {
    const node = p.spec?.nodeName ?? '<unscheduled>'
    try {
      const { stdout } = await run('kubectl', [
        'exec', p.metadata!.name!, '-n', k8sNamespace(), '-c', 'netd',
        '--', 'ip', '-4', 'route', 'show',
      ], { timeout: 60_000 })
      return { node, ...assessWorkloadRoutes(stdout, prefix) }
    } catch (err) {
      return {
        node,
        matched: 0,
        suggestions: [],
        error: err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : String(err),
      }
    }
  }))
}

/**
 * The shared verdict on a `probeWorkloadVeths` sweep — used by BOTH
 * `--adopt-cni` (where a failure is a refusal) and every `yaac cluster
 * check` (where it is a gate), so the two cannot drift.
 *
 * Re-checked on every cluster check on purpose. netd's readiness is Envoy's
 * config ack, which goes green with ZERO pod → veth mappings, so nothing
 * else in the datapath gate would ever notice a prefix that resolves
 * nothing — the misconfiguration would resurface later as silent no-egress,
 * which is exactly what this gate exists to prevent.
 *
 * Pure, so the whole policy is testable without a cluster.
 */
export function assessVethSource(
  outcomes: NodeVethOutcome[],
  prefix: string,
): { status: 'pass' | 'warn' | 'fail'; detail: string; fix?: string } {
  if (outcomes.length === 0) {
    return {
      status: 'warn',
      detail: `no running ${NETD_APP_NAME} pod to read the node routing table from — the `
        + `pod → veth source for ${prefix}* is unverified`,
      fix: 'netd must be up before its pod → veth source can be checked; the datapath '
        + 'gate reports whether it came up at all.',
    }
  }

  const errored = outcomes.filter((o) => o.error)
  const ok = outcomes.filter((o) => !o.error && o.matched > 0)
  const empty = outcomes.filter((o) => !o.error && o.matched === 0)
  const suggestions = [...new Set(empty.flatMap((o) => o.suggestions))].sort()
  const suggestionTail = suggestions.length > 0
    ? ` Their workload veths look like ${suggestions.map((s) => `${s}*`).join(', ')}; `
      + `set YAAC_CNI_VETH_PREFIX=${suggestions[0]}.`
    : ' Those nodes appear to write no per-workload host route at all, which yaac cannot '
      + 'use (the alternative source, Calico\'s WorkloadEndpoint, is served only by the '
      + 'optional Calico apiserver).'
  const VETH_FIX = 'netd resolves a pod to the veth its frames arrive on from the node\'s '
    + 'per-workload host routes — the one identity a sandboxed workload cannot forge. With '
    + 'no route matching the prefix it renders a chain with no per-pod rules, which looks '
    + 'exactly like a healthy netd and costs those nodes\' sessions their egress.'

  // A node whose routes look like workload veths under a DIFFERENT name is
  // an unambiguous prefix mismatch. A node with no per-workload-looking
  // route at all is ambiguous — it may simply have no local workloads yet
  // (netd and kube-proxy are hostNetwork and own no veth), which is the
  // normal state of a freshly added node.
  const mismatched = empty.filter((o) => o.suggestions.length > 0)
  const bare = empty.filter((o) => o.suggestions.length === 0)

  if (mismatched.length > 0) {
    return {
      status: 'fail',
      detail: `no per-workload host route matches ${prefix}* on `
        + `${mismatched.map((o) => o.node).slice(0, 4).join(', ')}`
        + `${mismatched.length > 4 ? `, +${mismatched.length - 4} more` : ''}`
        + (ok.length > 0
          ? ` (${ok.length} other node(s) resolve fine, so this reads as intermittent `
            + 'rather than broken).'
          : '.')
        + suggestionTail,
      fix: VETH_FIX,
    }
  }
  if (bare.length > 0 && ok.length === 0) {
    // Nothing anywhere. On any live cluster at least one node hosts a
    // non-hostNetwork pod (coredns, if nothing else), so this is the CNI
    // writing no per-workload host route rather than an idle fleet.
    return {
      status: 'fail',
      detail: `no per-workload host route of any kind on the ${bare.length} node(s) `
        + `checked, so nothing can match ${prefix}*.`
        + ' This CNI appears to write no per-workload host route at all, which yaac cannot '
        + 'use (the alternative source, Calico\'s WorkloadEndpoint, is served only by the '
        + 'optional Calico apiserver).',
      fix: VETH_FIX,
    }
  }
  if (bare.length > 0) {
    return {
      status: 'warn',
      detail: `${prefix}* resolves workloads on ${ok.length} node(s); `
        + `${bare.map((o) => o.node).slice(0, 4).join(', ')} have no per-workload route at `
        + 'all, which is also what a node with no local workloads looks like',
      fix: 'If those nodes do run pods, their CNI is not writing the per-workload host '
        + 'routes netd keys the redirect on and their sessions will have no egress.',
    }
  }
  if (errored.length > 0) {
    return {
      status: 'warn',
      detail: `${prefix}* resolves workloads on ${ok.length} node(s); unverified on `
        + `${errored.map((o) => `${o.node} (${o.error ?? 'exec failed'})`).slice(0, 3).join(', ')}`,
      fix: 'Those nodes\' netd pods could not be exec\'d, so their pod → veth source is '
        + 'unknown — not known-bad. Re-run the check once they are Running.',
    }
  }
  return {
    status: 'pass',
    detail: `${prefix}* resolves ${outcomes.reduce((n, o) => n + o.matched, 0)} workload `
      + `route(s) across all ${ok.length} node(s)`,
  }
}
