/**
 * Redirect claims — the document an INNER yaac publishes to ask that its
 * own worktree pods be redirected to its own proxy, and the document the
 * outer server republishes for netd once it has validated one.
 *
 * Why a claim at all: a nested install's cluster is a vcluster with no
 * nodes, so it cannot program the node's netfilter, and it must not be
 * given the authority to (see docs/nested-containers.md). It therefore
 * *decides* and the host *enforces*: claim-mode netd runs inside the
 * vcluster, computes the same rule-1 selection as a top-level netd, and
 * writes it here; host-mode netd programs it after re-checking it.
 *
 * Two hops, two documents:
 *
 *  1. `yaac-redirect-claim` in the inner install's namespace INSIDE the
 *     vcluster, holding one `RedirectClaim` under the `claim` key. The
 *     claim-mode pod references it as a volume, which is what makes the
 *     vcluster syncer copy it to the host namespace (`sync.toHost.configMaps`
 *     is `all: false` — only configmaps a synced pod uses are synced).
 *  2. `yaac-redirect-claims` in the INSTALL namespace, written by the outer
 *     server: one key per vcluster host namespace, each a `NamespaceClaims`
 *     naming the vcluster and the claims that survived validation.
 *
 * This module is only the wire format and its bounds. The envelope that
 * makes a claim safe to honour lives in targets.ts (`validateClaims`),
 * because it needs the host's view of pods.
 *
 * Nothing here trusts its input: hop 1's document is written inside a
 * vcluster whose tenant is cluster-admin, so parsing is total — anything
 * malformed, oversized, or of the wrong shape becomes "no claim", which
 * lands the pods it would have covered on the outer proxy.
 */

/** Must match the server's constants (netd cannot import from src/). */
export const CLAIMS_CONFIGMAP_NAME = 'yaac-redirect-claims'
export const INNER_CLAIM_CONFIGMAP_NAME = 'yaac-redirect-claim'
/** netd's own app label — what the server's claim informer selects on. */
export const NETD_APP_NAME = 'yaac-netd'
/** The single key both documents' payloads live under (hop 1). */
export const CLAIM_KEY = 'claim'

/**
 * Bounds, enforced on both hops. The inner document is tenant-writable, so
 * without them a claim could inflate netd's rule count and the republished
 * ConfigMap without bound. Generous enough that no real install notices:
 * one claim per inner install in a vcluster, one source per worktree pod.
 */
export const MAX_CLAIMS_PER_NAMESPACE = 64
export const MAX_SOURCES_PER_CLAIM = 512

/** One install's claim: "redirect these pod IPs to this pod IP." */
export interface RedirectClaim {
  /** The claiming install's data-dir hash — identity, not authority. */
  install: string
  /** The claimed proxy's pod IP (never a ClusterIP: see targets.ts). */
  proxyPodIp: string
  /** Pod IPs the claiming install wants redirected. */
  sources: string[]
}

/** The claims for one vcluster host namespace (hop 2, one CM key). */
export interface NamespaceClaims {
  /** The vcluster's name — the syncer's `managed-by` value. */
  vcluster: string
  claims: RedirectClaim[]
}

/** The fields netd reads off a ConfigMap. */
export interface NetdConfigMap {
  name: string
  namespace: string
  data: Record<string, string>
}

function isIpish(value: unknown): value is string {
  // Cheap shape gate only — containment in a pod CIDR and existence as a
  // live pod IP are what actually authorize an address (targets.ts).
  return typeof value === 'string' && value.length > 0 && value.length <= 45
}

/** Coerce unknown JSON into a claim; null when it is not one. */
export function parseRedirectClaim(raw: unknown): RedirectClaim | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const install = obj.install
  const proxyPodIp = obj.proxyPodIp
  if (typeof install !== 'string' || install.length === 0 || install.length > 128) return null
  if (!isIpish(proxyPodIp)) return null
  const rawSources = Array.isArray(obj.sources) ? obj.sources : []
  const sources = rawSources.filter(isIpish).slice(0, MAX_SOURCES_PER_CLAIM)
  return { install, proxyPodIp, sources }
}

/**
 * Parse hop 1's document (the value of the inner CM's `claim` key). An
 * empty string is the retraction claim-mode netd writes when it has no
 * proxy to point at, so it is "no claim", not an error.
 */
export function parseInnerClaimDocument(value: string | undefined): RedirectClaim | null {
  if (!value || value.trim().length === 0) return null
  try {
    return parseRedirectClaim(JSON.parse(value))
  } catch {
    return null
  }
}

/** Render hop 1's document. Sorted sources so an unchanged claim is byte-stable. */
export function renderInnerClaimDocument(claim: RedirectClaim): string {
  return JSON.stringify({
    install: claim.install,
    proxyPodIp: claim.proxyPodIp,
    sources: [...new Set(claim.sources)].sort().slice(0, MAX_SOURCES_PER_CLAIM),
  })
}

/** Render one hop-2 CM value. */
export function renderNamespaceClaims(value: NamespaceClaims): string {
  return JSON.stringify({
    vcluster: value.vcluster,
    claims: value.claims
      .slice(0, MAX_CLAIMS_PER_NAMESPACE)
      .map((claim) => ({
        install: claim.install,
        proxyPodIp: claim.proxyPodIp,
        sources: [...new Set(claim.sources)].sort().slice(0, MAX_SOURCES_PER_CLAIM),
      })),
  })
}

/**
 * Parse hop 2's whole ConfigMap: `{ <vcluster host namespace>: json }` →
 * claims by namespace. Unparseable keys are dropped, never thrown on: a
 * corrupt entry must cost one namespace its inner redirect, not netd's
 * entire pass.
 */
export function parseClaimsConfigMap(
  data: Record<string, string> | undefined,
): Map<string, NamespaceClaims> {
  const out = new Map<string, NamespaceClaims>()
  for (const [namespace, value] of Object.entries(data ?? {})) {
    let raw: unknown
    try {
      raw = JSON.parse(value)
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const obj = raw as Record<string, unknown>
    const vcluster = obj.vcluster
    if (typeof vcluster !== 'string' || vcluster.length === 0) continue
    const rawClaims = Array.isArray(obj.claims) ? obj.claims : []
    const claims = rawClaims
      .slice(0, MAX_CLAIMS_PER_NAMESPACE)
      .map(parseRedirectClaim)
      .filter((claim): claim is RedirectClaim => claim !== null)
    out.set(namespace, { vcluster, claims })
  }
  return out
}
