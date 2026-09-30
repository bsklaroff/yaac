/**
 * Egress-target selection: which yaac proxy each pod's redirected traffic
 * goes to. A workspace pod (labelled `yaac.workspace-id`) in this install's
 * namespace goes to this install's proxy; nothing else is redirected.
 * Pure: pods in, one target per pod out.
 */

/** Must match the server's LABEL_WORKSPACE_ID (netd can't import src/). */
export const LABEL_WORKSPACE_ID = 'yaac.workspace-id'
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
 * One redirect destination. `key` is stable across reconciles, names the
 * Envoy clusters, and includes the install namespace so installs never
 * collide. `ip` is the proxy Service's ClusterIP from netd's own namespace.
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

/** The target for this install's workspace pods. */
function outerTarget(input: SelectTargetsInput): EgressTarget | null {
  if (!input.outerProxyClusterIp) return null
  return { key: `outer/${input.installNamespace}`, ip: input.outerProxyClusterIp }
}

/**
 * Resolve every redirectable pod to one egress target. Other pods
 * (another install's, the proxy itself, anything without the workspace
 * label) are left out and get no rules, so a missing target only ever
 * reduces reachability. Sorted so rendered output is stable between passes.
 */
export function selectTargets(input: SelectTargetsInput): PodTarget[] {
  const outer = outerTarget(input)
  const out: PodTarget[] = []
  for (const pod of input.pods) {
    if (!pod.podIp) continue
    if (pod.namespace !== input.installNamespace) continue
    if (pod.labels.app === PROXY_APP_NAME) continue
    if (!pod.labels[LABEL_WORKSPACE_ID]) continue
    if (outer) out.push({ pod, target: outer })
  }
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
