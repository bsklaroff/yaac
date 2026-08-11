import { proxyClient } from './proxy-client'
import { createRuntimeSnapshot, k8sSnapshotOf } from '#runtime/k8s/view'
import type { TickSnapshot } from '#platform/k8s'
import type { RuntimeSnapshot } from '#runtime/contract'
import { serverLog } from '#log'

/**
 * Build `{ podIP: outerWorktreeId }` for every managed vcluster's host pods.
 *
 * yaac-in-yaac chains a vcluster's egress through the OUTER proxy (the inner
 * proxy's upstream dials, and any synced pod before an inner yaac opts in). That
 * traffic arrives at the outer proxy with the source pod's *host* IP, but those
 * pods live in the vcluster's own namespace with no `yaac.session-id` the
 * proxy's pod-watch can resolve — so the outer proxy fail-closes on it. The
 * server (host cluster-admin) knows each vcluster namespace's owning worktree
 * and can read the host pod IPs, so it supplies the mapping; the proxy then
 * judges chained egress against the OWNING outer worktree's allowlist.
 */
export async function buildVclusterAttribution(
  snapshot: TickSnapshot,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  for (const vc of await snapshot.vclusters()) {
    for (const pod of await snapshot.vclusterPods(vc.namespace)) {
      if (pod.podIP) map[pod.podIP] = vc.worktreeId
    }
  }
  return map
}

/** Stable serialization so an unchanged map can be detected (skip redundant pushes). */
function serialize(map: Record<string, string>): string {
  return Object.keys(map).sort().map((ip) => `${ip}=${map[ip]}`).join(',')
}

let lastPushed: string | null = null

/** Reset the last-pushed state (tests only). */
export function _resetVclusterAttributionForTests(): void {
  lastPushed = null
}

/**
 * Reconcile step: push the vcluster attribution map to the outer proxy
 * (see buildVclusterAttribution). Full-replace, so a torn-down pod's IP is
 * evicted on the next push. attach-only (never bootstraps the proxy, matching
 * the other proxy reconcilers). A non-empty map is pushed on every run —
 * vcluster pod deltas fire it within milliseconds of an IP appearing, and the
 * fast-poll cadence re-pushes so the outer proxy recovers its attribution
 * after a restart; an empty map is pushed only on the transition to empty
 * (e.g. the last vcluster was deleted).
 */
export async function reconcileVclusterAttribution(
  snapshot: RuntimeSnapshot = createRuntimeSnapshot(),
): Promise<void> {
  const map = await buildVclusterAttribution(k8sSnapshotOf(snapshot))
  const serialized = serialize(map)
  if (Object.keys(map).length === 0 && serialized === lastPushed) return
  if (!(await proxyClient.attachIfRunning())) return
  try {
    await proxyClient.registerVclusterAttribution(map)
    lastPushed = serialized
  } catch (err) {
    serverLog(
      '[server] vcluster-attribution push failed: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
}
