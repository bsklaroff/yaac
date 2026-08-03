import { k8sNamespace } from '#platform/k8s/kubectl'
import { NETD_APP_NAME } from '#platform/k8s/proxy-constants'
import type { VclusterPod } from './vcluster'

/**
 * Redirect claims — the bridge that lets a nested yaac decide its own
 * egress redirect without holding any authority over the node.
 *
 * A nested install's cluster is a vcluster with no nodes of its own, so it
 * cannot program the node's netfilter, and handing it the authority to do so
 * would hand its tenant the node. Instead its own claim-mode netd publishes
 * what it wants redirected, and the host programs it — after this module
 * validates it against facts only the host can see.
 *
 * The path, end to end:
 *
 *   claim-mode netd (inside the vcluster)
 *     writes ConfigMap `yaac-redirect-claim` in its own namespace
 *   → the vcluster syncer copies it into the host vcluster namespace
 *     (the claim-mode pod references it as a volume, which is what makes a
 *     `configMaps.all: false` syncer copy it)
 *   → THIS module validates it against the host's pods
 *   → ConfigMap `yaac-redirect-claims` in the install namespace
 *   → host netd, which re-validates and programs the redirect
 *
 * The synced document is tenant-writable: inside one session the inner yaac
 * and the agent code are the same trust domain, so a claim can never be
 * attributed to "the real inner yaac". Validation therefore does not try to
 * authenticate the claimant — it makes every expressible claim harmless, by
 * confining what a claim may NAME to the pods the host reports in that one
 * vcluster namespace. A pod IP is assigned by host IPAM and reported in host
 * pod status, so a tenant cannot mint one; a Service ClusterIP would be
 * unsafe here, since kube-proxy dereferences it from the node's host netns
 * where a tenant-authored Endpoints object can name any address on the
 * internet and no NetworkPolicy applies.
 *
 * netd repeats the same check with the pod CIDR list as an extra gate (see
 * k8s/netd/targets.ts). The duplication is deliberate: this module's
 * arithmetic is not in netd's trust path.
 */

/** ConfigMap in the INSTALL namespace holding the validated claims. */
export const REDIRECT_CLAIMS_CM_NAME = 'yaac-redirect-claims'
/** ConfigMap a claim-mode netd writes inside its own (inner) namespace. */
export const INNER_CLAIM_CM_NAME = 'yaac-redirect-claim'
/** The key both documents' payload lives under. */
export const CLAIM_KEY = 'claim'
/** Bounds mirrored in k8s/netd/claims.ts — a tenant document must not amplify. */
export const MAX_CLAIMS_PER_NAMESPACE = 64
export const MAX_SOURCES_PER_CLAIM = 512

/**
 * Is this host ConfigMap a synced claim?
 *
 * Matched on the syncer-translated NAME (`<name>-x-<ns>-x-<vcluster>`, which
 * preserves the original as a prefix) rather than on a label: labels
 * propagate today, but the claim path should not rest on that when the name
 * carries the same information. Nothing but the syncer can create objects in
 * a vcluster's host namespace, and a claim that reaches here is validated
 * regardless of what it is called.
 */
export function isClaimConfigMapName(name: string): boolean {
  return name === INNER_CLAIM_CM_NAME || name.startsWith(`${INNER_CLAIM_CM_NAME}-`)
}

/** One install's claim: "redirect these pod IPs to this pod IP." */
export interface RedirectClaim {
  install: string
  proxyPodIp: string
  sources: string[]
}

export interface ValidateClaimsInput {
  /** The vcluster's name — the syncer's `managed-by` value. */
  vclusterName: string
  /**
   * Every claim document found in the vcluster's host namespace (the value
   * of each synced claim ConfigMap's `claim` key).
   */
  documents: string[]
  /** Host pods in that namespace — the population a claim may name. */
  pods: VclusterPod[]
}

function parseClaim(raw: unknown): RedirectClaim | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const install = obj.install
  const proxyPodIp = obj.proxyPodIp
  if (typeof install !== 'string' || install.length === 0 || install.length > 128) return null
  if (typeof proxyPodIp !== 'string' || proxyPodIp.length === 0) return null
  const rawSources = Array.isArray(obj.sources) ? obj.sources : []
  const sources = rawSources.filter((ip): ip is string => typeof ip === 'string' && ip.length > 0)
  return { install, proxyPodIp, sources }
}

/**
 * Validate one vcluster's claim documents into the claims netd may program.
 *
 * A claim survives only if its target is a live synced pod of this vcluster;
 * its sources are filtered to the same population, minus the target itself (a
 * proxy redirected to itself is a loop — its own egress belongs on the
 * outer-proxy fallback). Sorted by install hash so a source two installs
 * claim resolves the same way on every pass instead of flapping the
 * rendering netd hashes.
 *
 * Total: a malformed or oversized document costs its own install the inner
 * redirect and nothing else.
 */
export function validateVclusterClaims(input: ValidateClaimsInput): RedirectClaim[] {
  // Only pods carrying the SYNCER's own managed-by label count — the one
  // label a tenant can neither forge nor shed.
  const syncedIps = new Set(
    input.pods
      .filter((pod) => !!pod.podIP)
      .filter((pod) => pod.labels['vcluster.loft.sh/managed-by'] === input.vclusterName)
      .map((pod) => pod.podIP as string),
  )
  const claims: RedirectClaim[] = []
  for (const document of input.documents) {
    if (claims.length >= MAX_CLAIMS_PER_NAMESPACE) break
    if (!document.trim()) continue
    let parsed: RedirectClaim | null = null
    try {
      parsed = parseClaim(JSON.parse(document))
    } catch {
      continue
    }
    if (!parsed) continue
    if (!syncedIps.has(parsed.proxyPodIp)) continue
    const sources = [...new Set(parsed.sources)]
      .filter((ip) => syncedIps.has(ip) && ip !== parsed.proxyPodIp)
      .sort()
      .slice(0, MAX_SOURCES_PER_CLAIM)
    if (sources.length === 0) continue
    claims.push({ install: parsed.install, proxyPodIp: parsed.proxyPodIp, sources })
  }
  return claims.sort((a, b) => (a.install < b.install ? -1 : a.install > b.install ? 1 : 0))
}

/** Render one namespace's validated claims as a ConfigMap value. */
export function renderNamespaceClaims(vclusterName: string, claims: RedirectClaim[]): string {
  return JSON.stringify({
    vcluster: vclusterName,
    claims: claims.slice(0, MAX_CLAIMS_PER_NAMESPACE),
  })
}

/**
 * The claims ConfigMap host netd watches. One object for every vcluster,
 * keyed by host namespace and rewritten whole, so a torn-down vcluster's
 * entry evicts itself with no separate GC.
 *
 * It lives in the install namespace precisely because nothing outside yaac
 * can write there: netd's rule-2 input is outer-authored, so a privileged
 * daemon never parses tenant data.
 */
export function buildRedirectClaimsConfigMapManifest(
  data: Record<string, string>,
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: REDIRECT_CLAIMS_CM_NAME,
      namespace: k8sNamespace(),
      labels: { app: NETD_APP_NAME },
    },
    data,
  }
}

/**
 * The claim ConfigMap a claim-mode netd owns. Created empty by `ensureNetd`
 * so the DaemonSet's volume reference resolves (and the syncer starts
 * copying it) before netd's first publish; netd then writes the `claim` key
 * itself. Deliberately carries no `data`, so re-applying it never clobbers
 * what netd published.
 */
export function buildInnerClaimConfigMapManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: INNER_CLAIM_CM_NAME,
      namespace: k8sNamespace(),
      labels: { app: NETD_APP_NAME },
    },
  }
}
