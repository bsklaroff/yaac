import { proxyClient } from '#lib/container/proxy-client'
import { kubectlGetJson } from '#lib/k8s/kubectl'
import type { TickSnapshot } from '#lib/k8s/tick-snapshot'
import { listVclusterNamespaces, type VclusterNamespaceInfo } from '#lib/k8s/vcluster'
import { serverLog } from '#log'

interface RawPodList {
  items?: Array<{ status?: { podIP?: string } }>
}

/**
 * Build `{ podIP: outerSessionId }` for every managed vcluster's host pods.
 *
 * yaac-in-yaac chains a vcluster's egress through the OUTER proxy (the inner
 * proxy's upstream dials, and any synced pod before an inner yaac opts in). That
 * traffic arrives at the outer proxy with the source pod's *host* IP, but those
 * pods live in the vcluster's own namespace with no `yaac.session-id` the
 * proxy's pod-watch can resolve — so the outer proxy fail-closes on it. The
 * server (host cluster-admin) knows each vcluster namespace's owning session
 * and can read the host pod IPs, so it supplies the mapping; the proxy then
 * judges chained egress against the OWNING outer session's allowlist.
 */
export async function buildVclusterAttribution(
  vclusters?: VclusterNamespaceInfo[],
): Promise<Record<string, string>> {
  vclusters ??= await listVclusterNamespaces()
  const map: Record<string, string> = {}
  for (const { namespace, sessionId } of vclusters) {
    const pods = await kubectlGetJson<RawPodList>(['get', 'pods', '-n', namespace, '-o', 'json'])
    for (const pod of pods?.items ?? []) {
      const ip = pod.status?.podIP
      if (ip) map[ip] = sessionId
    }
  }
  return map
}

/** Stable serialization so an unchanged map can be detected (skip redundant pushes). */
function serialize(map: Record<string, string>): string {
  return Object.keys(map).sort().map((ip) => `${ip}=${map[ip]}`).join(',')
}

let lastPushed: string | null = null

/**
 * Min interval between attribution rebuilds. Each rebuild runs one
 * `kubectl get pods` per vcluster namespace — at the 5s tick cadence that
 * was constant child-process churn scaling with vcluster count. The cost
 * of the interval: a brand-new inner pod's chained egress can fail-closed
 * at the outer proxy for up to this long before its IP is attributed (in
 * practice an inner pod takes longer than this to boot and first dial
 * out), and outer-proxy restart recovery is delayed by the same bound.
 */
export const VCLUSTER_ATTRIBUTION_INTERVAL_MS = 15_000

let lastRunMs = 0

/** Reset the throttle + last-pushed state (tests only). */
export function _resetVclusterAttributionForTests(): void {
  lastRunMs = 0
  lastPushed = null
}

/**
 * Background-loop tick step: push the vcluster attribution map to the outer
 * proxy (see buildVclusterAttribution). Full-replace, so a torn-down pod's IP is
 * evicted on the next push. attach-only (never bootstraps the proxy, matching
 * the other proxy reconcilers). A non-empty map is pushed every eligible tick
 * so the outer proxy recovers its attribution after a restart; an empty map is
 * pushed only on the transition to empty (e.g. the last vcluster was deleted).
 * Throttled to VCLUSTER_ATTRIBUTION_INTERVAL_MS.
 */
export async function reconcileVclusterAttribution(
  nowMs: number = Date.now(),
  snapshot?: TickSnapshot,
): Promise<void> {
  if (nowMs - lastRunMs < VCLUSTER_ATTRIBUTION_INTERVAL_MS) return
  lastRunMs = nowMs
  const map = await buildVclusterAttribution(
    await (snapshot ? snapshot.vclusters() : listVclusterNamespaces()),
  )
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
