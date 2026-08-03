import { k8sNamespace } from '#platform/k8s/kubectl'
import {
  LABEL_SESSION_ID,
  LABEL_VCLUSTER_MANAGED_BY,
  VCLUSTER_API_PORT,
} from '#platform/k8s/pods'
import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  INNER_PROXY_INGRESS_NP_NAME,
  INNER_SESSION_INGRESS_LOCK_NP_NAME,
  LABEL_ROLE,
  LABEL_VCLUSTER_NAMESPACE,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  RELAY_PORT,
  RELAY_PORT as RELAY,
  ROLE_BUILDER,
  ROLE_INNER_PROXY,
  SESSION_EGRESS_NP_NAME,
  SESSION_INGRESS_LOCK_NP_NAME,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_TUNNEL_PORT,
  VCLUSTER_EGRESS_FLOOR_NP_NAME,
} from '#platform/k8s/proxy-constants'

/**
 * Every yaac egress/ingress policy, as plain `networking.k8s.io/v1`
 * NetworkPolicy. The datapath these police is docs/session-egress.md.
 *
 * Plain NP only, deliberately: it is the one policy dialect every
 * enforcement backend speaks. Locally that is the Calico `yaac cluster
 * setup` installs; the managed ports this keeps cheap (GKE Dataplane V1,
 * AKS) enforce plain NP through *provider-managed* Calicos where Calico
 * CRDs are unsupported, so anything CRD-shaped would fork the policy model
 * per provider.
 *
 * Two patterns recur, both forced by what plain NP can express:
 *
 *  - Anything that must reach or be reached by the NODE (netd's Envoy
 *    dialing in from the host netns, kubelet probes, containerd pulling
 *    from a project registry) is an `ipBlock` over the node addresses,
 *    resolved at apply time by `nodeIpBlocks()` — NP has no selector for
 *    the host network namespace.
 *  - Cross-namespace peers need a `namespaceSelector`, which matches
 *    labels, so the server labels every vcluster namespace with
 *    LABEL_VCLUSTER_NAMESPACE for those rules to key on.
 *
 * These builders are pure so they stay unit-testable; the CIDR lists are
 * parameters, never lookups.
 */

/** `to`/`from` peer for a set of CIDRs. */
function ipBlocks(cidrs: string[]): Array<Record<string, unknown>> {
  return cidrs.map((cidr) => ({ ipBlock: { cidr } }))
}

const tcp = (port: number): Record<string, unknown> => ({ protocol: 'TCP', port })
const udp = (port: number): Record<string, unknown> => ({ protocol: 'UDP', port })

function np(
  name: string,
  namespace: string,
  spec: Record<string, unknown>,
  labels: Record<string, string> = { app: PROXY_APP_NAME },
): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace, labels },
    spec,
  }
}

/** Selector matching every session pod (the label the session builder stamps). */
const sessionPodSelector = {
  matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
}

/**
 * Session-pod EGRESS.
 *
 * This is the containment floor for every session, and its shape is the
 * whole fail-closed story: the ONLY world-ward rule is "the node, on
 * netd's reserved listener range". A session pod cannot address the
 * internet at all — 443/80 to world matches nothing here, so if netd has
 * not installed that pod's redirect (it is starting, restarting, or
 * broken), the pod's traffic keeps its original destination, takes the
 * FORWARD path, matches no rule, and is dropped. netd being late costs
 * egress; it can never grant it.
 *
 * Admitting the listener range is not a hole: those ports reach netd's
 * Envoy, which stamps the connection's real peer address into the
 * PROXY-protocol header regardless of how the connection arrived. A pod
 * dialing a listener directly therefore gets exactly the treatment its own
 * redirected traffic would get — it cannot impersonate another session,
 * and it still cannot reach the proxy's transparent ports (those are
 * node-only, see buildProxyIngressNpManifest).
 *
 * DNS is the one direct dial: the proxy's stub on 53/udp, which session
 * pods point `dnsPolicy: None` at.
 *
 * Deliberately NO in-cluster allowance for the per-project registry (5000)
 * or the vcluster API (8443): this policy is install-wide, so it cannot
 * express "the session's OWN project/vcluster" — a blanket rule would open
 * every registry and every vcluster API to every session (cross-project
 * image overwrite, issue #17). NetworkPolicy unions allow rules, so those
 * flows are admitted instead by the exactly-scoped per-project and
 * per-session policies applied at create time.
 */
export function buildSessionEgressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(SESSION_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: sessionPodSelector,
    policyTypes: ['Egress'],
    egress: [
      {
        to: ipBlocks(nodeCidrs),
        ports: [{
          protocol: 'TCP',
          port: NETD_LISTENER_PORT_BASE,
          endPort: NETD_LISTENER_PORT_END,
        }],
      },
      {
        to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
        ports: [udp(DNS_STUB_PORT)],
      },
    ],
  })
}

/**
 * Session-pod INGRESS: only the proxy's relay dials into streamd. Before
 * the relay nothing dialed session pods at all, so their ingress was
 * default-allow by omission; selecting them with any ingress rule makes it
 * default-deny, which is the point.
 */
export function buildSessionIngressLockNpManifest(): Record<string, unknown> {
  return np(SESSION_INGRESS_LOCK_NP_NAME, k8sNamespace(), {
    podSelector: sessionPodSelector,
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
        ports: [tcp(POD_STREAM_PORT)],
      },
    ],
  })
}

/**
 * Proxy INGRESS.
 *
 * The forgery lock lives here. Redirected traffic arrives from netd's
 * Envoy in the node's network namespace, so the transparent ports are
 * admitted from the NODE CIDRs only — pods cannot reach them at all.
 * Envoy is a trusted DaemonSet and the sole originator of PROXY-protocol
 * preambles, so no workload can inject a forged source.
 *
 * The control API and relay are likewise node-only: the server reaches
 * them through a kubectl port-forward, which is a CRI-side dial into the
 * pod netns and never traverses this policy at all — the network-side
 * allowance exists for a node-local server using the direct-TCP override.
 *
 * DNS is the one pod-facing port: session pods in this namespace, and
 * vcluster-synced pods in labeled vcluster namespaces.
 */
export function buildProxyIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(PROXY_INGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        // netd's Envoy (host netns) delivering redirected session egress,
        // plus the kubelet readiness probe and any node-local server.
        from: ipBlocks(nodeCidrs),
        ports: [
          tcp(TRANSPARENT_HTTPS_PORT),
          tcp(TRANSPARENT_HTTP_PORT),
          tcp(TRANSPARENT_TUNNEL_PORT),
          tcp(PROXY_PORT),
          tcp(RELAY_PORT),
        ],
      },
      {
        from: [{ podSelector: sessionPodSelector }],
        ports: [udp(DNS_STUB_PORT)],
      },
      {
        // A vcluster's synced pods resolve through the outer stub when no
        // inner proxy has taken over their DNS.
        from: [{
          namespaceSelector: { matchLabels: { [LABEL_VCLUSTER_NAMESPACE]: 'true' } },
          podSelector: { matchExpressions: [{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'Exists' }] },
        }],
        ports: [udp(DNS_STUB_PORT)],
      },
    ],
  })
}

/**
 * Install-namespace world-egress default-deny for everything that is
 * neither the proxy nor a session pod nor a builder.
 *
 * Plain NP has no deny verb, so this is expressed the way NP does it: an
 * empty `egress` list over a selector, which default-denies every selected
 * pod. NetworkPolicy has no deny that beats an allow, so this simply
 * unions with the scoped allows other policies grant — the exclusions
 * below are about which pods need NO egress at all, not about escaping a
 * deny.
 *
 *  - the proxy: the one pod that legitimately reaches the internet.
 *  - session pods: governed by buildSessionEgressNpManifest.
 *  - builder pods: trust-split image builds fetch upstream packages and
 *    push to a registry (docs/trust-split-builds.md); their own scoped
 *    policy governs them.
 *
 * `NotIn`/`DoesNotExist` also match pods carrying no such label, so
 * registries, mocks, and anything added later stay covered by default.
 */
export function buildEgressWorldDenyNpManifest(): Record<string, unknown> {
  return np(EGRESS_WORLD_DENY_NAME, k8sNamespace(), {
    podSelector: {
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME] },
        { key: LABEL_SESSION_ID, operator: 'DoesNotExist' },
        { key: LABEL_ROLE, operator: 'NotIn', values: [ROLE_BUILDER] },
      ],
    },
    policyTypes: ['Egress'],
    egress: [],
  })
}

/**
 * The vcluster's synced-pod egress floor — the single containment policy
 * for everything running inside a per-session vcluster, and the one a
 * tenant cannot escape: it selects on `managed-by`, stamped by the syncer
 * on every synced pod, which a tenant inside the vcluster can neither
 * forge nor shed.
 *
 * Admits exactly:
 *  - the node's netd listener range (their redirect — outer proxy by
 *    default, their own install's inner proxy once netd sees one),
 *  - the vcluster API on 8443,
 *  - sibling synced pods on any port (inner services, the vcluster
 *    CoreDNS, an inner proxy's DNS stub — all `managed-by`, so matched
 *    unforgeably),
 *  - the outer proxy's DNS stub, for pods with no inner proxy yet.
 *
 * Everything else — raw world, the host, the host apiserver, other
 * namespaces — is denied by the default-deny this policy creates.
 *
 * Applied at vcluster-creation time BEFORE the chart, so the floor is in
 * force before the first synced pod exists.
 */
export function buildVclusterEgressFloorNpManifest(
  vcNamespace: string,
  vcName: string,
  nodeCidrs: string[],
): Record<string, unknown> {
  const managedBy = { matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName } }
  return np(VCLUSTER_EGRESS_FLOOR_NP_NAME, vcNamespace, {
    podSelector: {
      matchExpressions: [{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'Exists' }],
    },
    policyTypes: ['Egress'],
    egress: [
      {
        to: ipBlocks(nodeCidrs),
        ports: [{
          protocol: 'TCP',
          port: NETD_LISTENER_PORT_BASE,
          endPort: NETD_LISTENER_PORT_END,
        }],
      },
      {
        to: [{ podSelector: { matchLabels: { app: 'vcluster', release: vcName } } }],
        ports: [tcp(VCLUSTER_API_PORT)],
      },
      { to: [{ podSelector: managedBy }] },
      {
        // Cross-namespace to the outer proxy's stub: plain NP needs the
        // install namespace named by label, so the server labels it.
        to: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': k8sNamespace() } },
          podSelector: { matchLabels: { app: PROXY_APP_NAME } },
        }],
        ports: [udp(DNS_STUB_PORT)],
      },
    ],
  })
}

/**
 * Inner-proxy INGRESS inside a vcluster namespace. Same trust model as the
 * outer proxy's: transparent ports and the control API from the node only
 * (netd's Envoy is the sole legitimate caller), streamd relay from the
 * OWNING outer session pod, DNS from the vcluster's own synced pods.
 */
export function buildInnerProxyIngressNpManifest(
  vcNamespace: string,
  vcName: string,
  /** The OWNING outer session id — the only pod admitted to the relay. */
  ownerSessionId: string,
  nodeCidrs: string[],
): Record<string, unknown> {
  return np(INNER_PROXY_INGRESS_NP_NAME, vcNamespace, {
    podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_INNER_PROXY } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: ipBlocks(nodeCidrs),
        ports: [
          tcp(TRANSPARENT_HTTPS_PORT),
          tcp(TRANSPARENT_HTTP_PORT),
          tcp(TRANSPARENT_TUNNEL_PORT),
          tcp(PROXY_PORT),
        ],
      },
      {
        // The nested server (the owning outer session pod, in the install
        // namespace) dials the inner proxy's pod IP directly. Other
        // sessions stay locked out; the bearer auth line is the second gate.
        from: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': k8sNamespace() } },
          podSelector: { matchLabels: { [LABEL_SESSION_ID]: ownerSessionId } },
        }],
        ports: [tcp(RELAY)],
      },
      {
        from: [{ podSelector: { matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName } } }],
        ports: [udp(DNS_STUB_PORT)],
      },
    ],
  })
}

/**
 * Synced session-pod INGRESS lock — the inner counterpart of
 * buildSessionIngressLockNpManifest. Synced session pods accept streamd
 * dials from their own vcluster's inner proxies only.
 */
export function buildInnerSessionIngressLockNpManifest(
  vcNamespace: string,
  vcName: string,
): Record<string, unknown> {
  return np(INNER_SESSION_INGRESS_LOCK_NP_NAME, vcNamespace, {
    podSelector: {
      matchExpressions: [
        { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [vcName] },
        { key: LABEL_SESSION_ID, operator: 'Exists' },
      ],
    },
    policyTypes: ['Ingress'],
    ingress: [
      {
        from: [{
          podSelector: {
            matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName, [LABEL_ROLE]: ROLE_INNER_PROXY },
          },
        }],
        ports: [tcp(POD_STREAM_PORT)],
      },
    ],
  })
}

/**
 * The vcluster control-plane pod's egress lock. It holds host-API
 * credentials, so it is the one pod in a vcluster namespace that could be
 * an escape hatch; it gets the host apiserver, kube-dns, its own synced
 * pods, and itself, and nothing else.
 *
 * `managed-by DoesNotExist` is load-bearing, not cosmetic: the real
 * control-plane pod is chart-created and carries NO managed-by label,
 * whereas EVERY synced pod carries it (syncer-stamped, unforgeable).
 * Without the guard a tenant could create a synced pod labelled
 * `app=vcluster, release=<vc>` — those labels propagate to the host pod —
 * and, since NP unions allows, inherit this policy's apiserver egress.
 */
export function buildVclusterControlPlaneNpManifest(
  vcNamespace: string,
  vcName: string,
  labels: Record<string, string>,
  apiserverCidrs: string[],
): Record<string, unknown> {
  return np(`${vcName}-control-plane`, vcNamespace, {
    podSelector: {
      matchLabels: { app: 'vcluster', release: vcName },
      matchExpressions: [{ key: LABEL_VCLUSTER_MANAGED_BY, operator: 'DoesNotExist' }],
    },
    policyTypes: ['Egress'],
    egress: [
      { to: ipBlocks(apiserverCidrs) },
      {
        to: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        }],
      },
      { to: [{ podSelector: { matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName } } }] },
      { to: [{ podSelector: { matchLabels: { app: 'vcluster', release: vcName } } }] },
    ],
  }, labels)
}
