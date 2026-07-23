import {
  buildInnerEgressRedirectCecManifest,
  buildInnerProxyIngressCnpManifest,
  buildInnerSessionEgressRedirectCnpManifest,
  buildInnerSessionIngressLockCnpManifest,
  innerRedirectObjectName,
} from '#features/cluster/proxy-manifests'
import {
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
  INNER_SESSION_INGRESS_LOCK_CNP_NAME,
  LABEL_PROJECTION,
  PROJECTION_INNER_REDIRECT,
  PROXY_APP_NAME,
} from '#features/cluster/proxy-constants'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { LABEL_DATA_DIR_HASH } from '#platform/k8s/pods'
import { createTickSnapshot, type TickSnapshot } from '#platform/k8s/tick-snapshot'
import type { VclusterService } from '#features/cluster/vcluster'
import { serverLog } from '#log'

interface RawObjectList {
  items: Array<{ metadata: { name: string; labels?: Record<string, string> } }>
}

/** A host-synced inner proxy Service and the inner install that owns it. */
interface InnerProxy {
  serviceName: string
  installHash: string
}

/** Unlabeled-service notes already logged, to avoid per-pass log spam. */
const loggedUnlabeled = new Set<string>()

/**
 * Per-namespace serialization of the last successfully-applied projection.
 * Delta passes whose recomputed desired state matches skip the pass's
 * kubectl work entirely — pod/service churn must not become apply spam —
 * while resync passes ignore it, re-asserting the objects so externally
 * mutated projections heal within the resync interval.
 */
const lastProjected = new Map<string, string>()

/** Reset the projection memo + log dedupe (tests only). */
export function _resetInnerRedirectStateForTests(): void {
  lastProjected.clear()
  loggedUnlabeled.clear()
}

/**
 * Select the host-synced inner proxy Services among a vcluster namespace's
 * syncer-managed Services — one per inner yaac install (the nested
 * session's own server, plus any per-run e2e servers an agent spawns
 * inside it).
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
 */
function selectInnerProxies(vcNamespace: string, services: VclusterService[]): InnerProxy[] {
  const proxies: InnerProxy[] = []
  for (const { name, labels } of services) {
    if (name !== PROXY_APP_NAME && !name.startsWith(`${PROXY_APP_NAME}-`)) continue
    const installHash = labels[LABEL_DATA_DIR_HASH]
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
 * Reconcile step for yaac-in-yaac inner egress (design B,
 * docs/nested-containers.md). Projects only the DYNAMIC inner
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
 * per-pass reassert. Trade-off: a change to the fallback builder reaches a
 * running vcluster only on recreate.
 *
 * The session pod never gets host RBAC: the server (host cluster-admin) is the
 * sole writer and rebuilds from trusted builders, so a tenant can't author an
 * escape. Idempotent and best-effort; the reconciler isolates step errors.
 * Service deltas fire it within milliseconds of an inner proxy appearing;
 * the `lastProjected` memo keeps unrelated churn from re-running the
 * per-vcluster kubectl work.
 */
export async function reconcileInnerRedirects(
  snapshot: TickSnapshot = createTickSnapshot(),
): Promise<void> {
  const vclusters = await snapshot.vclusters()
  for (const ns of [...lastProjected.keys()]) {
    if (!vclusters.some((vc) => vc.namespace === ns)) lastProjected.delete(ns)
  }

  for (const vc of vclusters) {
    const proxies = selectInnerProxies(vc.namespace, await snapshot.vclusterServices(vc))
    const serialized = proxies.map((p) => `${p.serviceName}=${p.installHash}`).join(',')
    if (!snapshot.resync && lastProjected.get(vc.namespace) === serialized) continue

    const desired = new Set<string>()
    for (const p of proxies) {
      desired.add(`ciliumenvoyconfig/${innerRedirectObjectName(INNER_EGRESS_REDIRECT_CEC_NAME, p.installHash)}`)
      desired.add(`ciliumnetworkpolicy/${innerRedirectObjectName(INNER_SESSION_EGRESS_REDIRECT_CNP_NAME, p.installHash)}`)
    }
    if (proxies.length > 0) {
      desired.add(`ciliumnetworkpolicy/${INNER_PROXY_INGRESS_CNP_NAME}`)
      desired.add(`ciliumnetworkpolicy/${INNER_SESSION_INGRESS_LOCK_CNP_NAME}`)
    }

    await pruneInnerRedirects(vc.namespace, desired)
    for (const p of proxies) {
      // CEC before the CNP that references its listeners.
      await kubectlApply(buildInnerEgressRedirectCecManifest(vc.namespace, p.serviceName, p.installHash))
      await kubectlApply(buildInnerSessionEgressRedirectCnpManifest(vc.namespace, vc.name, p.installHash))
    }
    if (proxies.length > 0) {
      await kubectlApply(buildInnerProxyIngressCnpManifest(vc.namespace, vc.name, vc.sessionId))
      // Inner session ingress lock: synced session pods accept streamd
      // dials from their vcluster's inner proxies only.
      await kubectlApply(buildInnerSessionIngressLockCnpManifest(vc.namespace, vc.name))
    }
    lastProjected.set(vc.namespace, serialized)
  }
}
