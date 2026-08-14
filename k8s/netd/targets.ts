/**
 * Egress-target selection: which yaac proxy a given pod's redirected
 * traffic is steered to.
 *
 * Exactly ONE target is chosen per pod, evaluated on every reconcile, so
 * there is no precedence to reason about — the selection IS the decision,
 * and it lives in ordinary code that unit tests can pin. A worktree pod in
 * an install namespace (`yaac.worktree-id`) is steered to that install's
 * proxy; nothing else is redirected at all.
 *
 * Pure: a snapshot of pods in, a target per pod out. The watches and the
 * iptables/Envoy writers live elsewhere.
 */

/**
 * Must match the server's constants (netd cannot import from src/). This is
 * LABEL_WORKTREE_ID: the key every worktree pod carries.
 */
export const LABEL_WORKTREE_ID = 'yaac.worktree-id'
/** Deployment/Service name of every yaac proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'

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
 * `ip` is the proxy Service's ClusterIP, read from netd's own install
 * namespace, which no tenant can write.
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

export interface SelectTargetsInput {
  /** Every pod netd can see (all namespaces). */
  pods: NetdPod[]
  /** The install namespace this netd serves. */
  installNamespace: string
  /** ClusterIP of the proxy, or null when it is not up yet. */
  outerProxyClusterIp: string | null
}

/** Every install-namespace worktree pod's destination. */
function outerTarget(input: SelectTargetsInput): EgressTarget | null {
  if (!input.outerProxyClusterIp) return null
  return { key: `outer/${input.installNamespace}`, ip: input.outerProxyClusterIp }
}

/**
 * Resolve every redirectable pod to exactly one egress target.
 *
 * Pods with no target (no worktree label; or a proxy pod, which must never
 * be redirected to itself) are simply absent from the result — netd
 * programs no rules for them, and their egress is whatever their
 * NetworkPolicy allows. That is why a missing target can only ever mean
 * LESS reachability, never more.
 */
export function selectTargets(input: SelectTargetsInput): PodTarget[] {
  const outer = outerTarget(input)
  const out: PodTarget[] = []
  for (const pod of input.pods) {
    if (!pod.podIp) continue
    // Only this install's own worktree pods: a sibling install's pods are
    // its netd's business, not ours.
    if (pod.namespace !== input.installNamespace) continue
    // The proxy must never be redirected — it is the thing egress is
    // redirected TO, and a self-redirect would be an infinite loop.
    if (pod.labels.app === PROXY_APP_NAME) continue
    if (!pod.labels[LABEL_WORKTREE_ID]) continue
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
