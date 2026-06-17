import { proxyClient } from '@/lib/container/proxy-client'
import { kubectlGetJson } from '@/lib/k8s/kubectl'
import { listVclusterNamespaces } from '@/lib/k8s/vcluster'
import { daemonLog } from '@/daemon/log'

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
 * daemon (host cluster-admin) knows each vcluster namespace's owning session
 * and can read the host pod IPs, so it supplies the mapping; the proxy then
 * judges chained egress against the OWNING outer session's allowlist.
 */
export async function buildVclusterAttribution(): Promise<Record<string, string>> {
  const vclusters = await listVclusterNamespaces()
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
 * Background-loop tick step: push the vcluster attribution map to the outer
 * proxy (see buildVclusterAttribution). Full-replace, so a torn-down pod's IP is
 * evicted on the next push. attach-only (never bootstraps the proxy, matching
 * the other proxy reconcilers). A non-empty map is pushed every tick so the
 * outer proxy recovers its attribution after a restart; an empty map is pushed
 * only on the transition to empty (e.g. the last vcluster was deleted).
 */
export async function reconcileVclusterAttribution(): Promise<void> {
  const map = await buildVclusterAttribution()
  const serialized = serialize(map)
  if (Object.keys(map).length === 0 && serialized === lastPushed) return
  if (!(await proxyClient.attachIfRunning())) return
  try {
    await proxyClient.registerVclusterAttribution(map)
    lastPushed = serialized
  } catch (err) {
    daemonLog(
      '[daemon] vcluster-attribution push failed: '
      + (err instanceof Error ? err.message : String(err)),
    )
  }
}
