import {
  buildInnerEgressRedirectCecManifest,
  buildInnerProxyIngressCnpManifest,
  buildInnerSessionEgressRedirectCnpManifest,
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
  innerRedirectObjectName,
  LABEL_PROJECTION,
  PROJECTION_INNER_REDIRECT,
  PROXY_APP_NAME,
} from '#lib/k8s/bootstrap'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#lib/k8s/kubectl'
import { LABEL_DATA_DIR_HASH, LABEL_VCLUSTER_MANAGED_BY } from '#lib/k8s/pods'
import type { TickSnapshot } from '#lib/k8s/tick-snapshot'
import { listVclusterNamespaces } from '#lib/k8s/vcluster'
import { serverLog } from '#log'

interface RawObjectList {
  items: Array<{ metadata: { name: string; labels?: Record<string, string> } }>
}

/** A host-synced inner proxy Service and the inner install that owns it. */
interface InnerProxy {
  serviceName: string
  installHash: string
}

/** Unlabeled-service notes already logged, to avoid per-tick log spam. */
const loggedUnlabeled = new Set<string>()

/** Min interval between reconcile passes — see reconcileInnerRedirects. */
export const INNER_REDIRECT_INTERVAL_MS = 30_000

let lastRunMs = 0

/** Reset the throttle (tests only). */
export function _resetInnerRedirectThrottleForTests(): void {
  lastRunMs = 0
}

/**
 * Discover the host-synced inner proxy Services in a vcluster's namespace —
 * one per inner yaac install (the nested session's own server, plus any
 * per-run e2e servers an agent spawns inside it).
 *
 * The inner yaac creates a `yaac-proxy` Service inside its vcluster; the syncer
 * lands it in the host namespace under a translated name
 * (`yaac-proxy-x-<ns>-x-<vc>`) carrying the `managed-by=<vc>` label. We match by
 * that label plus the preserved name prefix rather than a hard-coded name (the
 * translation scheme is a vcluster internal). The Service's own
 * `yaac.data-dir-hash` label (stamped by `buildProxyServiceManifest`, synced
 * verbatim like tenant pod labels) names the owning install — it scopes that
 * install's projected redirect to its own pods. A `yaac-proxy` Service without
 * the label (an inner yaac older than this scheme) gets no projection: its
 * sessions stay on the outer-proxy fallback, contained but without inner
 * governance — recreate the nested session to upgrade it.
 *
 * MUST-VERIFY (N4 e2e): the synced Service label shape — validated end to end
 * only once the nesting e2e runs against an outer server with this code.
 */
async function findInnerProxyServices(
  vcNamespace: string,
  vcName: string,
): Promise<InnerProxy[]> {
  const list = await kubectlGetJson<RawObjectList>([
    'get', 'services', '-n', vcNamespace,
    '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${vcName}`,
  ])
  const proxies: InnerProxy[] = []
  for (const svc of list?.items ?? []) {
    const { name, labels } = svc.metadata
    if (name !== PROXY_APP_NAME && !name.startsWith(`${PROXY_APP_NAME}-`)) continue
    const installHash = labels?.[LABEL_DATA_DIR_HASH]
    if (!installHash) {
      const key = `${vcNamespace}/${name}`
      if (!loggedUnlabeled.has(key)) {
        loggedUnlabeled.add(key)
        serverLog(
          `[inner-redirect] ${key} has no ${LABEL_DATA_DIR_HASH} label — `
          + 'pre-per-install inner yaac (or label lost in sync); not projecting',
        )
      }
      continue
    }
    proxies.push({ serviceName: name, installHash })
  }
  // Deterministic apply order (and stable unit-test expectations).
  return proxies.sort((a, b) => a.serviceName.localeCompare(b.serviceName))
}

/**
 * Delete projected objects that no longer correspond to a live inner proxy.
 * Lists only objects stamped `yaac.projection=inner-redirect` — never the
 * vcluster's egress floor, which shares the namespace and the `app` label but
 * is containment, not projection. `desired` keys are `<kind>/<name>`.
 */
async function pruneInnerRedirects(vcNamespace: string, desired: Set<string>): Promise<void> {
  // Pre-per-install projections used fixed names with no projection label;
  // left in place they'd double-redirect every pod alongside the per-install
  // override. Deleted unconditionally (ignore-not-found) — droppable once no
  // vcluster created before the per-install scheme remains.
  await kubectlWithRetry([
    'delete',
    `ciliumenvoyconfig/${INNER_EGRESS_REDIRECT_CEC_NAME}`,
    `ciliumnetworkpolicy/${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}`,
    '-n', vcNamespace, '--ignore-not-found',
  ])
  for (const kind of ['ciliumenvoyconfig', 'ciliumnetworkpolicy']) {
    const list = await kubectlGetJson<RawObjectList>([
      'get', kind, '-n', vcNamespace,
      '-l', `${LABEL_PROJECTION}=${PROJECTION_INNER_REDIRECT}`,
    ])
    for (const item of list?.items ?? []) {
      if (desired.has(`${kind}/${item.metadata.name}`)) continue
      await kubectlWithRetry([
        'delete', kind, item.metadata.name, '-n', vcNamespace, '--ignore-not-found',
      ])
    }
  }
}

/**
 * Background-loop tick step for yaac-in-yaac inner egress (design B,
 * docs/yaac-in-yaac-inner-egress.md). Projects only the DYNAMIC inner
 * overrides — the part that depends on inner yaac proxies existing. For each
 * managed vcluster:
 *
 *   - For EACH live inner proxy (a host-synced `yaac-proxy` Service in the
 *     vcluster's namespace carrying an install hash), PROJECT that install's
 *     override: an inner CEC EDS-backed by that Service + an override CNP that
 *     redirects the install's synced pods (`managed-by=<vc>` +
 *     `data-dir-hash=<install>`, excluding inner proxies) to it at the normal
 *     priority (which beats the fallback). Several inner installs coexist in
 *     one vcluster (the ambient nested server plus per-run e2e servers), each
 *     routed to its OWN proxy.
 *   - Project the shared inner proxy-ingress lock while any proxy is up.
 *   - PRUNE stale projections (installs whose proxy is gone) by the
 *     projection label, plus the legacy fixed-name objects.
 *
 * The low-precedence FALLBACK redirect (the synced-pod egress floor → the outer
 * proxy) is NOT applied here: it's a static per-vcluster policy seeded at
 * vcluster-creation time (ensureSessionVcluster) and torn down with the
 * namespace. Nothing in the system deletes it once created (a tenant has no host
 * RBAC; CNPs/NetworkPolicies don't sync out of the vcluster), so there is no
 * per-tick reassert. Trade-off: a change to the fallback builder reaches a
 * running vcluster only on recreate.
 *
 * The session pod never gets host RBAC: the server (host cluster-admin) is the
 * sole writer and rebuilds from trusted builders, so a tenant can't author an
 * escape. Idempotent and best-effort; the loop isolates step errors.
 * Throttled to INNER_REDIRECT_INTERVAL_MS — the per-vcluster reconcile is
 * several kubectl calls (service discovery, prune listings, re-applies), far
 * too heavy for every 5s tick. The cost of the interval: a freshly-appeared
 * inner proxy waits up to this long for its projection upgrade, during which
 * its install's synced pods stay on the (containment-equivalent) outer-proxy
 * fallback seeded at vcluster creation.
 */
export async function reconcileInnerRedirects(
  nowMs: number = Date.now(),
  snapshot?: TickSnapshot,
): Promise<void> {
  if (nowMs - lastRunMs < INNER_REDIRECT_INTERVAL_MS) return
  lastRunMs = nowMs
  const vclusters = await (snapshot ? snapshot.vclusters() : listVclusterNamespaces())
  if (vclusters.length === 0) return

  for (const { name, namespace } of vclusters) {
    const proxies = await findInnerProxyServices(namespace, name)

    const desired = new Set<string>()
    for (const p of proxies) {
      desired.add(`ciliumenvoyconfig/${innerRedirectObjectName(INNER_EGRESS_REDIRECT_CEC_NAME, p.installHash)}`)
      desired.add(`ciliumnetworkpolicy/${innerRedirectObjectName(INNER_SESSION_EGRESS_REDIRECT_CNP_NAME, p.installHash)}`)
    }
    if (proxies.length > 0) {
      desired.add(`ciliumnetworkpolicy/${INNER_PROXY_INGRESS_CNP_NAME}`)
    }

    await pruneInnerRedirects(namespace, desired)
    for (const p of proxies) {
      // CEC before the CNP that references its listeners.
      await kubectlApply(buildInnerEgressRedirectCecManifest(namespace, p.serviceName, p.installHash))
      await kubectlApply(buildInnerSessionEgressRedirectCnpManifest(namespace, name, p.installHash))
    }
    if (proxies.length > 0) {
      await kubectlApply(buildInnerProxyIngressCnpManifest(namespace, name))
    }
  }
}
