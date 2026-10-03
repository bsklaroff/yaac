import {
  cniVethPrefix,
  podCidrSources,
} from '#drivers/k8s/cluster'
import {
  NETD_APP_NAME,
  RUNTIME_CLASS_GVISOR,
  isAbsent,
  k8sErrorSummary,
  k8sNamespace,
  listObjects,
  readObject,
  untoleratedTaints,
} from '#drivers/k8s/substrate'
import type { NodeTaint, PodToleration } from '#drivers/k8s/substrate'
import type { execFileAsync } from '#drivers/k8s/substrate'
import { env } from '@yaac/shared/env'

/**
 * The CNI gate for `--byo`: checks that a Calico yaac did not install
 * (self-managed, or provider-managed on GKE, AKS or EKS) can carry the
 * netd egress redirect (docs/cluster-setup.md "The CNI gate",
 * docs/workspace-egress.md).
 *
 * The redirect needs pod egress to pass through host netfilter and
 * kube-proxy to translate ClusterIPs. When these assumptions are wrong,
 * workspaces silently lose egress, so every check refuses with a specific
 * reason. Cilium and Calico's eBPF dataplane both bypass netfilter and
 * are refused.
 */

/** Everything the gate reads about the cluster's CNI, in one shape. */
interface CniFacts {
  /** calico-node's rollout. `present` is null when the read failed. */
  calico: { present: boolean | null; ready: number; desired: number }
  felix: {
    /**
     * `spec.bpfEnabled` across every FelixConfiguration, including per-node
     * `node.<name>` overrides. Null when nothing sets it.
     */
    bpfEnabled: boolean | null
    /**
     * `FELIX_BPFENABLED` on the calico-node container; null when unset,
     * `'unevaluable'` when it comes from a `valueFrom` reference.
     */
    bpfEnabledEnv: boolean | 'unevaluable' | null
    /** `spec.chainInsertMode`; null when unset (Felix defaults to Insert). */
    chainInsertMode: string | null
    /** `spec.bpfKubeProxyIptablesCleanupEnabled`; null when unset. */
    bpfKubeProxyIptablesCleanupEnabled: boolean | null
    /** False when the read failed; nothing about Felix is then recorded. */
    evaluated: boolean
  }
  /**
   * kube-proxy pods, per node (a node without one loses egress on its own).
   * `external` is the operator saying it runs outside a pod (e.g. k3s).
   */
  kubeProxy: {
    pods: number
    running: number
    nodes: string[]
    external: boolean
    /** False when the read failed. */
    evaluated: boolean
  }
  /** Every node a workspace could be scheduled on. */
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
  /** Whether netd's PriorityClass exists; null when the read failed. */
  systemNodeCriticalPresent: boolean | null
  /** What netd will be told to match workload veths on. */
  vethPrefix: string
  /**
   * Checks whose read failed for a reason other than absence (RBAC, a
   * timeout, bad output). Each is a refusal: for the eBPF check, treating a
   * failed read as "no FelixConfiguration" would pass an eBPF cluster.
   */
  unevaluated: Array<{ check: string; cause: string }>
}

/**
 * The verdict: any `refusals` block the adoption; `warnings` do not break
 * the datapath; `notes` record what was verified.
 */
interface CniAssessment {
  refusals: string[]
  warnings: string[]
  notes: string[]
}

/** Judge the facts from `gatherCniFacts`. Pure, so testable without a cluster. */
export function assessCniAdoption(facts: CniFacts): CniAssessment {
  const refusals: string[] = []
  const warnings: string[] = []
  const notes: string[] = []

  // A check whose read failed is reported only by the unevaluated refusal
  // at the end, not as an absence.
  // 1. Calico is present and rolled out (this also refuses Cilium).
  if (facts.calico.present === null) {
    // Reported by the unevaluated refusal below.
  } else if (!facts.calico.present) {
    refusals.push(
      'no calico-node found in kube-system. yaac\'s egress redirect is a nat DNAT at '
      + 'each pod\'s host-side veth, so it needs a CNI whose pod egress traverses host '
      + 'netfilter and which leaves ClusterIP translation to kube-proxy — Calico in its '
      + 'iptables dataplane, self-managed or provider-managed. Cilium is not supported '
      + 'in any configuration (its eBPF host-routing bypasses the hook the redirect '
      + 'needs). Install Calico into the cluster (or let a kind install bring its own).',
    )
  } else if (!(facts.calico.ready > 0) || facts.calico.ready !== facts.calico.desired) {
    refusals.push(
      `calico-node is ${facts.calico.ready}/${facts.calico.desired} ready — NetworkPolicy `
      + 'is not being enforced on every node, and session egress lockdown is the policy '
      + 'plane, not netd. Wait for the rollout (`kubectl -n kube-system rollout status '
      + 'daemonset/calico-node`) and re-run.',
    )
  }

  // 2. Calico's eBPF dataplane bypasses iptables, so the redirect would
  //    never fire.
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
    // Set via ConfigMap or fieldRef, so the value is unknown; do not guess.
    refusals.push(
      'the calico-node container sets FELIX_BPFENABLED from a `valueFrom` reference, so '
      + 'this cannot tell whether Calico is in its eBPF dataplane — and eBPF would make '
      + 'the redirect count zero packets forever. Resolve the reference and confirm the '
      + 'iptables dataplane (`kubectl get felixconfiguration default -o '
      + 'jsonpath=\'{.spec.bpfEnabled}\'`), then set it to a literal value or unset it.',
    )
  }

  // 3. kube-proxy translates the proxy ClusterIP that netd's Envoy dials
  //    from the host netns.
  if (facts.kubeProxy.external) {
    // The operator says kube-proxy runs outside a pod (e.g. k3s); record it.
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
    // Checked per node: a node without kube-proxy loses egress on its own.
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

  // 4. chainInsertMode is recorded, not enforced: netd appends its jump to
  //    nat PREROUTING, so either mode works.
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

  // 5. The redirect exclusion set. If too narrow, pod-to-pod 443/80 to a
  //    pod IP outside it is DNAT'd into the proxy.
  const { configured, pools, nodes, droppedConfigured } = facts.podCidrs
  const all = [...new Set([...configured, ...pools, ...nodes])].sort()
  if (droppedConfigured.length > 0) {
    // Refuse rather than silently drop a malformed entry.
    refusals.push(
      `YAAC_POD_CIDRS contains ${droppedConfigured.length} entr(y/ies) that are not usable `
      + `IPv4 CIDRs: ${droppedConfigured.join(', ')}. Every octet must be 0-255 and the `
      + 'mask 0-32 — these become `-d <cidr>` lines in netd\'s iptables-restore document, '
      + 'which rejects the whole document on one bad line. Dropping them silently would '
      + 'leave the redirect exclusion set narrower than you configured it.',
    )
  }
  if (all.length === 0 && facts.podCidrs.unreadable.length > 0) {
    // Reported by the unevaluated refusal below.
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
      // Node spec.podCIDR may not reflect a foreign IPAM's allocation.
      warnings.push(
        'the only pod-CIDR source is node spec.podCIDR — no Calico IPPool answered. That '
        + 'field describes the kubeadm allocation, which a foreign IPAM (a VPC CNI, for '
        + 'instance) does not use. If pods here get addresses outside it, set '
        + 'YAAC_POD_CIDRS to the real range(s): a pod IP outside the list is treated as '
        + 'world and redirected into the proxy.',
      )
    }
  }

  // 6. netd needs hostNetwork, NET_ADMIN/NET_RAW and
  //    system-node-critical, none of which is guaranteed on an adopted
  //    cluster.
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
    'install and registry namespaces labelled for the privileged Pod Security '
    + 'Standard (netd is hostNetwork with NET_ADMIN/NET_RAW, which baseline forbids) — '
    + 'namespace-scoped, so this relaxes nothing outside the namespaces yaac creates',
  )

  // 7. Checks that could not be evaluated, last so concrete problems lead.
  if (facts.unevaluated.length > 0) {
    // Grouped by cause: usually one problem fails several reads.
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

interface RawFelixConfig {
  metadata?: { name?: string }
  spec?: {
    bpfEnabled?: boolean
    chainInsertMode?: string
    bpfKubeProxyIptablesCleanupEnabled?: boolean
  }
}

interface RawPod {
  spec?: { nodeName?: string }
  status?: { phase?: string }
}

interface RawSchedulableNode {
  metadata?: { name?: string }
  spec?: { unschedulable?: boolean; taints?: NodeTaint[] }
}

/**
 * What a sandboxed pod tolerates, from the gvisor RuntimeClass (admission
 * merges its tolerations into every pod naming it). Empty when the class
 * does not exist yet.
 */
async function workspaceTolerations(): Promise<PodToleration[]> {
  const rc = valueOf(await settle(() => readObject<{ scheduling?: { tolerations?: PodToleration[] } }>({
    apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass', name: RUNTIME_CLASS_GVISOR,
  })))
  return rc?.scheduling?.tolerations ?? []
}

/**
 * A cluster read that tells "not there" apart from "could not find out",
 * since absence is meaningful here (no FelixConfiguration means iptables
 * defaults) and an RBAC denial must not pass for it.
 */
type Read<T> =
  | { kind: 'found'; value: T }
  | { kind: 'absent' }
  | { kind: 'error'; message: string }

async function settle<T>(read: () => Promise<T | null>): Promise<Read<T>> {
  try {
    const value = await read()
    return value === null ? { kind: 'absent' } : { kind: 'found', value }
  } catch (err) {
    if (isAbsent(err)) return { kind: 'absent' }
    return { kind: 'error', message: k8sErrorSummary(err) }
  }
}

/** A list read as `{ items }`; a resource type the cluster lacks is absent. */
function readList<T>(
  apiVersion: string,
  kind: string,
  opts: Parameters<typeof listObjects>[2] = {},
): Promise<Read<{ items?: T[] }>> {
  return settle(async () => ({ items: await listObjects<T>(apiVersion, kind, opts) }))
}

/** The value if found, else null — for reads whose absence is meaningful. */
function valueOf<T>(read: Read<T>): T | null {
  return read.kind === 'found' ? read.value : null
}

/**
 * Felix's parsing of a boolean env var. Anything not recognizably false
 * counts as true, so an unfamiliar spelling refuses rather than passing an
 * eBPF cluster.
 */
const FALSEY = new Set(['', 'false', 'f', 'no', 'n', '0', 'off'])

function felixBool(raw: string): boolean {
  return !FALSEY.has(raw.trim().toLowerCase())
}

/**
 * Read everything `assessCniAdoption` judges. An absent object is a fact,
 * not an error: a provider-managed Calico has no FelixConfiguration, which
 * means Felix runs its iptables defaults.
 */
export async function gatherCniFacts(): Promise<CniFacts> {
  const kubeProxyPods = (labelSelector: string) =>
    readList<RawPod>('v1', 'Pod', { namespace: 'kube-system', labelSelector })
  const [calicoRead, felixRead, kubeProxyRead, priorityRead, nodeRead, cidrs, tolerations] =
    await Promise.all([
      settle(() => readObject<RawDaemonSet>({
        apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'calico-node', namespace: 'kube-system',
      })),
      // All of them: per-node overrides count too.
      readList<RawFelixConfig>('crd.projectcalico.org/v1', 'FelixConfiguration'),
      // kubeadm/EKS/kind label `k8s-app`; GKE and AKS label `component`.
      kubeProxyPods('k8s-app=kube-proxy').then(async (byK8sApp) => {
        if (byK8sApp.kind === 'error') return byK8sApp
        if ((valueOf(byK8sApp)?.items ?? []).length > 0) return byK8sApp
        return kubeProxyPods('component=kube-proxy')
      }),
      settle(() => readObject({
        apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', name: 'system-node-critical',
      })),
      readList<RawSchedulableNode>('v1', 'Node'),
      podCidrSources(),
      workspaceTolerations(),
    ])

  // Errors become unevaluated checks, named so the refusal says which.
  const unevaluated: CniFacts['unevaluated'] = []
  const note = (check: string, read: Read<unknown>): void => {
    if (read.kind === 'error') unevaluated.push({ check, cause: read.message })
  }
  note('calico-node DaemonSet', calicoRead)
  note('Calico FelixConfiguration (the eBPF-dataplane check)', felixRead)
  note('kube-proxy pods', kubeProxyRead)
  note('system-node-critical PriorityClass', priorityRead)
  note('node list', nodeRead)
  // The pod-CIDR reads report their own failures; surface them too,
  // or a denied `ippools` read would silently narrow the exclusion set.
  unevaluated.push(...cidrs.unreadable.map((u) => ({
    check: `pod-CIDR source: ${u.source}`, cause: u.cause,
  })))

  const calicoDs = valueOf(calicoRead)
  const felixItems = valueOf(felixRead)?.items ?? []
  const kubeProxyItems = valueOf(kubeProxyRead)?.items ?? []

  // Felix can also enable eBPF from the container env.
  const bpfEntry = (calicoDs?.spec?.template?.spec?.containers ?? [])
    .find((c) => c.name === 'calico-node')?.env
    ?.find((e) => e.name === 'FELIX_BPFENABLED')
  const bpfEnabledEnv = bpfEntry === undefined
    ? null
    // Sourced from a ConfigMap/fieldRef, so the value is unknown.
    : bpfEntry.value === undefined ? 'unevaluable' as const : felixBool(bpfEntry.value)

  const anyFelix = <T>(pick: (spec: RawFelixConfig['spec']) => T | undefined): T | null =>
    felixItems.map((f) => pick(f.spec)).find((v) => v !== undefined) ?? null

  return {
    calico: {
      present: calicoRead.kind === 'error' ? null : calicoRead.kind === 'found',
      ready: calicoDs?.status?.numberReady ?? 0,
      desired: calicoDs?.status?.desiredNumberScheduled ?? 0,
    },
    felix: {
      // Any object enabling it makes the cluster eBPF.
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
    // Nodes a workspace could land on, using the same taint matching as
    // `cluster check`, so a tainted workspace pool whose toleration is on
    // the RuntimeClass still counts.
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
 * Parse a node's routing table for workload veth routes matching netd's
 * prefix (the same format `k8s/netd/routes.ts` parses). `suggestions` are
 * prefixes of workload-looking routes that do not match, to suggest a
 * better `YAAC_CNI_VETH_PREFIX`.
 */
function assessWorkloadRoutes(
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
    // Only suggest veth-like names with a hash suffix (not `eth0`). The
    // alpha match is lazy because hex digits are letters too: a greedy one
    // would turn `enia7b3c9d1e2f4` into `enia`.
    const family = /^([a-z]+?)[0-9a-f]{6,}$/.exec(iface)?.[1]
    if (family) suggestions.add(family)
  }
  return { matched, suggestions: [...suggestions].sort() }
}

/** One netd pod's answer about its own node's routing table. */
interface NodeVethOutcome {
  node: string
  matched: number
  suggestions: string[]
  /** Set when the exec failed — unverified, which is not the same as zero. */
  error?: string
}

/**
 * Read `ip route` from every netd pod (hostNetwork, so each shows its
 * node's table). Every pod, not one, because mixed node pools can name
 * veths differently.
 */
export async function probeWorkloadVeths(
  run: typeof execFileAsync,
  prefix: string,
): Promise<NodeVethOutcome[]> {
  const pods = await listObjects<{
    metadata?: { name?: string }
    spec?: { nodeName?: string }
    status?: { phase?: string }
  }>('v1', 'Pod', { namespace: k8sNamespace(), labelSelector: `app=${NETD_APP_NAME}` })

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
 * Verdict on a `probeWorkloadVeths` sweep, used by both `--byo` and
 * `yaac cluster check`. Nothing else notices a veth prefix that matches
 * nothing, since netd reports ready with zero mappings. Pure.
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

  // Veth-like routes under another name mean a prefix mismatch. No
  // veth-like routes may just mean a new node with no workloads yet.
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
    // No veth routes on any node (coredns alone would create one), so
    // the CNI writes no per-workload host routes.
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
