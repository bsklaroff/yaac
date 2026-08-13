/**
 * Egress-target selection: which yaac proxy a given pod's redirected
 * traffic is steered to.
 *
 * Exactly ONE target is chosen per pod, evaluated on every reconcile, so
 * there is no precedence to reason about — the selection IS the decision,
 * and it lives in ordinary code that unit tests can pin.
 *
 *   1. A worktree pod in an install namespace (`yaac.worktree-id`) → that
 *      install's OUTER proxy.
 *   2. A vcluster-synced pod in a vcluster namespace THIS install owns,
 *      whose pod IP a VALIDATED redirect claim names as a source → the
 *      claiming install's proxy pod. This is the yaac-in-yaac override; the
 *      claim comes from the inner install's own claim-mode netd, by way of
 *      the outer server (see claims.ts).
 *   3. Any other synced pod in a vcluster namespace this install owns —
 *      including a claimed proxy itself, and every pod no claim names → the
 *      vcluster's owning install's OUTER proxy. This is the fallback that
 *      gives synced pods working (contained) egress before/without an inner
 *      yaac, and it is what makes chaining loop-free: the inner proxy's own
 *      upstream dials ride it to the outer proxy.
 *
 * The invariant that makes rule 2 safe to expose to a tenant at all:
 *
 *   Every address a claim can steer traffic TO is the status.podIP of a pod
 *   the HOST apiserver reports in a vcluster namespace this install owns,
 *   and lies inside the cluster's pod CIDRs.
 *
 * Pod IPs are assigned by host IPAM and reported in host pod status, so a
 * vcluster tenant cannot mint one. That is what keeps a forged claim
 * non-escalating: the worst it achieves is aiming the tenant's own pods at
 * the tenant's own pod, whose egress still rides rule 3 to the outer proxy
 * under the outer allowlist. A ClusterIP would NOT be safe here — it is
 * dereferenced by kube-proxy from the node's host netns, where a
 * tenant-authored Endpoints object can name any address on the internet and
 * no NetworkPolicy applies.
 *
 * Note what the invariant is not: an authentication of the inner yaac.
 * Inside one worktree the inner yaac and the agent code are the same trust
 * domain, so no claim can be attributed to "the real inner yaac". Every
 * expressible claim is made harmless instead.
 *
 * Pure: a snapshot of pods + claims in, a target per pod out. The watches
 * and the iptables/Envoy writers live elsewhere.
 */

import { ipInAnyCidr } from 'yaac-netd/cidr'
import {
  MAX_CLAIMS_PER_NAMESPACE,
  MAX_SOURCES_PER_CLAIM,
  type NamespaceClaims,
  type RedirectClaim,
} from 'yaac-netd/claims'

/**
 * Must match the server's constants (netd cannot import from src/). This is
 * LABEL_WORKTREE_ID: the key every worktree pod carries.
 */
export const LABEL_WORKTREE_ID = 'yaac.worktree-id'
export const LABEL_VCLUSTER_MANAGED_BY = 'vcluster.loft.sh/managed-by'
/** Deployment/Service name of every yaac proxy, outer and inner. */
export const PROXY_APP_NAME = 'yaac-proxy'

/**
 * Does this vcluster namespace belong to the install netd serves?
 *
 * The server names every vcluster namespace `<install ns>-vc-<vcluster>`
 * (`vclusterNamespace()`), prefixed precisely so coexisting installs do not
 * collide. netd is the other half of that contract.
 *
 * Load-bearing, not cosmetic. netd watches EVERY namespace, and several
 * installs share a node — the real `yaac` one plus an e2e run's
 * `yaac-test-<run-id>`, each with its own netd. Unscoped, every install's
 * netd claims every OTHER install's synced pods and DNATs them at its own
 * proxy. Both chains hang off nat PREROUTING by append, so the winner is
 * whichever install's jump was appended first — a function of restart
 * history, since netd removes its jump on SIGTERM and re-appends at the
 * back on the way up. The loser's pods land on a proxy that cannot resolve
 * them (its pod-watch is namespace-scoped, and its vcluster-attribution map
 * covers only vclusters its own server created), so they fail closed with
 * no egress at all.
 */
export function isOwnVclusterNamespace(namespace: string, installNamespace: string): boolean {
  return namespace.startsWith(`${installNamespace}-vc-`)
}

/** The fields netd reads off a Pod. */
export interface NetdPod {
  name: string
  namespace: string
  podIp: string
  labels: Record<string, string>
}

/** The fields netd reads off a Service. */
export interface NetdService {
  name: string
  namespace: string
  clusterIp: string
  labels: Record<string, string>
}

/**
 * One redirect destination: a proxy's address plus the three transparent
 * ports. `key` names it stably across reconciles (it is what the Envoy
 * cluster names hash), and is namespace-scoped so two installs — the real
 * one and an ephemeral e2e `yaac-test-<run-id>` — never collide.
 *
 * `ip` is a Service ClusterIP for an outer target (read from netd's own
 * install namespace, which no tenant can write) and a pod IP for a claimed
 * inner proxy (see the invariant above).
 */
export interface EgressTarget {
  key: string
  ip: string
}

/** A pod and the target its traffic is redirected to. */
export interface PodTarget {
  pod: NetdPod
  target: EgressTarget
}

export interface ValidateClaimsInput {
  /** Claims as published by the server, one entry per vcluster namespace. */
  claims: Map<string, NamespaceClaims>
  /** Every pod netd can see (all namespaces). */
  pods: NetdPod[]
  /** The install namespace this netd serves. */
  installNamespace: string
  /** Every CIDR the cluster allocates pod IPs from. */
  podCidrs: string[]
}

/**
 * netd's independent re-check of the claims the server published — the
 * invariant at the top of this file, enforced here and nowhere else.
 *
 * The server validates before publishing; netd validates before
 * programming. Deliberately duplicated rather than shared: the server's
 * arithmetic is not in netd's trust path, and this is the check that stands
 * between a claim and the node's nat table.
 *
 * A claim survives only if its proxy IP is a live synced pod of the named
 * vcluster in that namespace and sits inside the pod CIDRs; sources are
 * filtered to the same population. Claims are returned in install order so
 * a source two claims name resolves the same way on every pass.
 */
export function validateClaims(input: ValidateClaimsInput): Map<string, RedirectClaim[]> {
  const out = new Map<string, RedirectClaim[]>()
  for (const [namespace, entry] of input.claims) {
    // A sibling install's vcluster is its netd's business, not ours.
    if (!isOwnVclusterNamespace(namespace, input.installNamespace)) continue
    // The population a claim may name: pods the HOST reports in this
    // namespace carrying the syncer's own managed-by label, which no tenant
    // can forge or shed.
    const syncedIps = new Set(
      input.pods
        .filter((pod) => pod.namespace === namespace && !!pod.podIp)
        .filter((pod) => pod.labels[LABEL_VCLUSTER_MANAGED_BY] === entry.vcluster)
        .map((pod) => pod.podIp),
    )
    const claims: RedirectClaim[] = []
    for (const claim of [...entry.claims].sort((a, b) => (a.install < b.install ? -1 : 1))) {
      if (claims.length >= MAX_CLAIMS_PER_NAMESPACE) break
      if (!syncedIps.has(claim.proxyPodIp)) continue
      if (!ipInAnyCidr(claim.proxyPodIp, input.podCidrs)) continue
      const sources = claim.sources
        .filter((ip) => syncedIps.has(ip))
        // A proxy redirected to itself is an infinite loop; its own egress
        // belongs on rule 3, which is what chains it to the outer proxy.
        .filter((ip) => ip !== claim.proxyPodIp)
        .slice(0, MAX_SOURCES_PER_CLAIM)
      if (sources.length === 0) continue
      claims.push({ install: claim.install, proxyPodIp: claim.proxyPodIp, sources })
    }
    if (claims.length > 0) out.set(namespace, claims)
  }
  return out
}

export interface SelectTargetsInput {
  /** Every pod netd can see (all namespaces). */
  pods: NetdPod[]
  /** The install namespace this netd serves (the outer yaac's). */
  installNamespace: string
  /** ClusterIP of the outer proxy, or null when it is not up yet. */
  outerProxyClusterIp: string | null
  /**
   * Redirect claims, as published by the server. Passed unvalidated on
   * purpose: selectTargets validates them itself, so there is no call
   * shape that can feed the dataplane an unchecked claim.
   */
  claims?: Map<string, NamespaceClaims>
  /** Every CIDR the cluster allocates pod IPs from (claim validation). */
  podCidrs?: string[]
}

/**
 * The outer target — every install-namespace worktree pod's destination,
 * and the fallback for synced pods.
 */
function outerTarget(input: SelectTargetsInput): EgressTarget | null {
  if (!input.outerProxyClusterIp) return null
  return { key: `outer/${input.installNamespace}`, ip: input.outerProxyClusterIp }
}

/**
 * Resolve every redirectable pod to exactly one egress target.
 *
 * Pods with no target (no worktree label and not vcluster-synced; or a
 * proxy pod, which must never be redirected to itself) are simply absent
 * from the result — netd programs no rules for them, and their egress is
 * whatever their NetworkPolicy allows. That is why a missing target can
 * only ever mean LESS reachability, never more.
 */
export function selectTargets(input: SelectTargetsInput): PodTarget[] {
  const outer = outerTarget(input)
  const claims = validateClaims({
    claims: input.claims ?? new Map<string, NamespaceClaims>(),
    pods: input.pods,
    installNamespace: input.installNamespace,
    podCidrs: input.podCidrs ?? [],
  })
  // Source pod IP → its claimed target. Claims arrive in install order and
  // the first one wins, so two installs claiming one pod resolve the same
  // way on every pass instead of flapping the rendering.
  const claimedByPodIp = new Map<string, EgressTarget>()
  for (const [namespace, entry] of claims) {
    for (const claim of entry) {
      for (const source of claim.sources) {
        if (claimedByPodIp.has(source)) continue
        claimedByPodIp.set(source, {
          key: `inner/${namespace}/${claim.install}`,
          ip: claim.proxyPodIp,
        })
      }
    }
  }

  const out: PodTarget[] = []
  for (const pod of input.pods) {
    if (!pod.podIp) continue
    // The outer proxy must never be redirected — it is the thing egress is
    // redirected TO, and a self-redirect would be an infinite loop. Claimed
    // inner proxies ARE redirected (rule 3 chains them to the outer proxy),
    // so only the install-namespace proxy is excluded here.
    if (pod.namespace === input.installNamespace && pod.labels.app === PROXY_APP_NAME) continue

    const managedBy = pod.labels[LABEL_VCLUSTER_MANAGED_BY]
    if (!managedBy) {
      // Rule 1: an install-namespace worktree pod.
      if (pod.namespace !== input.installNamespace) continue
      if (!pod.labels[LABEL_WORKTREE_ID]) continue
      if (outer) out.push({ pod, target: outer })
      continue
    }

    // Rules 2 and 3 govern vclusters THIS install owns, and only those:
    // a sibling install's synced pods are its netd's business, not ours.
    if (!isOwnVclusterNamespace(pod.namespace, input.installNamespace)) continue

    // Rule 2: the yaac-in-yaac override, when a validated claim names this
    // pod. Claims are already scoped to their own namespace's synced pods,
    // so a match here cannot come from another vcluster.
    const claimed = claimedByPodIp.get(pod.podIp)
    if (claimed) {
      out.push({ pod, target: claimed })
      continue
    }

    // Rule 3: fallback to the owning install's outer proxy.
    if (outer) out.push({ pod, target: outer })
  }
  // Stable order so the rendered rules and Envoy config are byte-stable
  // between passes (the memo that suppresses no-op writes depends on it).
  return out.sort((a, b) => {
    const an = `${a.pod.namespace}/${a.pod.name}`
    const bn = `${b.pod.namespace}/${b.pod.name}`
    return an < bn ? -1 : an > bn ? 1 : 0
  })
}

/** The distinct targets referenced by a selection, in stable key order. */
export function distinctTargets(selected: PodTarget[]): EgressTarget[] {
  const byKey = new Map<string, EgressTarget>()
  for (const { target } of selected) byKey.set(target.key, target)
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * The proxy pod a claim-mode netd should name: its own install namespace's
 * proxy, lowest IP first so a rollout with two live pods does not flap the
 * claim. Null when no proxy pod is up, which is how claim-mode retracts.
 */
export function selectClaimProxyPodIp(pods: NetdPod[], installNamespace: string): string | null {
  const ips = pods
    .filter((pod) => pod.namespace === installNamespace && pod.labels.app === PROXY_APP_NAME)
    .map((pod) => pod.podIp)
    .filter((ip) => !!ip)
    .sort()
  return ips[0] ?? null
}
