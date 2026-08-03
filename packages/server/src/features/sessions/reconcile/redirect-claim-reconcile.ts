import { type TickSnapshot, createTickSnapshot, kubectlApply } from '#platform/k8s'
import {
  CLAIM_KEY,
  buildRedirectClaimsConfigMapManifest,
  isClaimConfigMapName,
  renderNamespaceClaims,
  validateVclusterClaims,
} from '#features/cluster'
import { serverLog } from '#log'

/**
 * Reconcile step: validate each vcluster's redirect claims and republish
 * them for netd (see features/cluster/redirect-claims.ts for the whole
 * path and its trust argument).
 *
 * Same shape as the vcluster-attribution step: the server holds host truth
 * a datapath component cannot derive for itself, and hands over only what it
 * has checked. Both sides of the hop are event-driven — the claim reaches the
 * host through the vcluster syncer, so this never touches a vcluster's API
 * and therefore never wakes a sleeping one (docs/vcluster-scale-to-zero.md).
 */
export async function buildValidatedClaimData(
  snapshot: TickSnapshot,
): Promise<Record<string, string>> {
  const data: Record<string, string> = {}
  for (const vc of await snapshot.vclusters()) {
    const [pods, configMaps] = await Promise.all([
      snapshot.vclusterPods(vc.namespace),
      snapshot.vclusterConfigMaps(vc.namespace),
    ])
    const documents = configMaps
      .filter((cm) => isClaimConfigMapName(cm.name))
      .map((cm) => cm.data[CLAIM_KEY] ?? '')
      .filter((doc) => !!doc)
    if (documents.length === 0) continue
    const claims = validateVclusterClaims({
      vclusterName: vc.name,
      documents,
      pods,
    })
    // A namespace whose every claim was rejected gets no entry at all, which
    // reads the same to netd as "nobody claimed anything": rule 3, the outer
    // proxy. Dropping reachability is the only direction this can fail in.
    if (claims.length === 0) continue
    data[vc.namespace] = renderNamespaceClaims(vc.name, claims)
  }
  return data
}

/** Stable serialization so an unchanged claim set writes nothing. */
function serialize(data: Record<string, string>): string {
  return Object.keys(data).sort().map((ns) => `${ns}=${data[ns]}`).join('\n')
}

let lastApplied: string | null = null

/** Reset the last-applied state (tests only). */
export function _resetRedirectClaimsForTests(): void {
  lastApplied = null
}

/**
 * Apply the validated claims. Full-replace, so a departed vcluster's or a
 * withdrawn install's entry evicts itself; the ConfigMap is written even when
 * empty on the first pass, so `kubectl -n <ns> get cm yaac-redirect-claims`
 * is always the answer to "what has the host been asked to redirect".
 */
export async function reconcileRedirectClaims(
  snapshot: TickSnapshot = createTickSnapshot(),
): Promise<void> {
  const data = await buildValidatedClaimData(snapshot)
  const serialized = serialize(data)
  if (serialized === lastApplied) return
  try {
    await kubectlApply(buildRedirectClaimsConfigMapManifest(data))
    lastApplied = serialized
    serverLog(`[server] redirect claims: ${Object.keys(data).length} vcluster(s) claimed`)
  } catch (err) {
    serverLog(
      '[server] redirect-claim apply failed: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
}
