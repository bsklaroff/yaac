import {
  buildInnerEgressRedirectCecManifest,
  buildInnerProxyIngressCnpManifest,
  buildInnerSessionEgressRedirectCnpManifest,
  buildVclusterFallbackRedirectCecManifest,
  buildVclusterFallbackRedirectCnpManifest,
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
  PROXY_APP_NAME,
} from '@/lib/k8s/bootstrap'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { LABEL_VCLUSTER_MANAGED_BY, listVclusterNamespaces } from '@/lib/k8s/vcluster'

interface RawServiceList {
  items: Array<{ metadata: { name: string } }>
}

/**
 * Discover the host-synced inner proxy Service in a vcluster's namespace.
 *
 * The inner yaac creates a `yaac-proxy` Service inside its vcluster; the syncer
 * lands it in the host namespace under a translated name
 * (`yaac-proxy-x-<ns>-x-<vc>`) carrying the `managed-by=<vc>` label. We match by
 * that label plus the preserved name prefix rather than a hard-coded name (the
 * translation scheme is a vcluster internal). Its presence is the inner yaac's
 * opt-in signal; absence means no inner egress to project.
 *
 * MUST-VERIFY (N4 e2e): the exact synced Service name/label shape — the existing
 * vcluster e2e has no inner proxy, so this discovery is validated end to end only
 * once the nesting e2e runs.
 */
async function findInnerProxyService(vcNamespace: string, vcName: string): Promise<string | null> {
  const list = await kubectlGetJson<RawServiceList>([
    'get', 'services', '-n', vcNamespace,
    '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${vcName}`,
  ])
  const svc = (list?.items ?? []).find(
    (s) => s.metadata.name === PROXY_APP_NAME || s.metadata.name.startsWith(`${PROXY_APP_NAME}-`),
  )
  return svc?.metadata.name ?? null
}

const INNER_REDIRECT_OBJECTS: Array<{ kind: string; name: string }> = [
  { kind: 'ciliumenvoyconfig', name: INNER_EGRESS_REDIRECT_CEC_NAME },
  { kind: 'ciliumnetworkpolicy', name: INNER_SESSION_EGRESS_REDIRECT_CNP_NAME },
  { kind: 'ciliumnetworkpolicy', name: INNER_PROXY_INGRESS_CNP_NAME },
]

/** Tear down the projected host objects for a vcluster (idempotent). */
async function pruneInnerRedirect(vcNamespace: string): Promise<void> {
  for (const { kind, name } of INNER_REDIRECT_OBJECTS) {
    await kubectlWithRetry(['delete', kind, name, '-n', vcNamespace, '--ignore-not-found'])
  }
}

/**
 * Background-loop tick step for yaac-in-yaac inner egress (design B,
 * plans/yaac-in-yaac-inner-egress.md). For each managed vcluster:
 *
 *   - ALWAYS apply the low-precedence FALLBACK redirect (synced pods → the outer
 *     proxy) so they have working egress the moment they exist.
 *   - If its inner proxy is up (a host-synced `yaac-proxy` Service in the
 *     vcluster's namespace), PROJECT the inner override: an inner CEC EDS-backed
 *     by that Service + an override CNP that redirects the vcluster's synced
 *     pods (`managed-by=<vc>`, excluding the inner proxy) to it at the normal
 *     priority (which beats the fallback) + the inner proxy-ingress lock.
 *   - Else PRUNE any stale inner override (the fallback stays).
 *
 * The session pod never gets host RBAC: the daemon (host cluster-admin) is the
 * sole writer and rebuilds from trusted builders, so a tenant can't author an
 * escape. The fallback objects are torn down with the vcluster namespace.
 * Idempotent and best-effort; the loop isolates step errors.
 */
export async function reconcileInnerRedirects(): Promise<void> {
  const vclusters = await listVclusterNamespaces()
  if (vclusters.length === 0) return

  for (const { name, namespace } of vclusters) {
    await kubectlApply(buildVclusterFallbackRedirectCecManifest(namespace))
    await kubectlApply(buildVclusterFallbackRedirectCnpManifest(namespace, name))

    const innerProxyService = await findInnerProxyService(namespace, name)
    if (!innerProxyService) {
      await pruneInnerRedirect(namespace)
      continue
    }
    await kubectlApply(buildInnerEgressRedirectCecManifest(namespace, innerProxyService))
    await kubectlApply(buildInnerSessionEgressRedirectCnpManifest(namespace, name))
    await kubectlApply(buildInnerProxyIngressCnpManifest(namespace, name))
  }
}
