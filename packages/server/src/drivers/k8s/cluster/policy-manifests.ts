import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  INNER_PROXY_INGRESS_NP_NAME,
  INNER_WORKTREE_INGRESS_LOCK_NP_NAME,
  LABEL_ROLE,
  LABEL_WORKTREE_ID,
  LABEL_VCLUSTER_MANAGED_BY,
  LABEL_VCLUSTER_NAMESPACE,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  RELAY_PORT,
  ROLE_BUILDER,
  ROLE_INNER_PROXY,
  WORKTREE_EGRESS_NP_NAME,
  WORKTREE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  VCLUSTER_API_PORT,
  VCLUSTER_EGRESS_FLOOR_NP_NAME,
  RELAY_PORT as RELAY,
  k8sNamespace,
} from '#drivers/k8s/substrate'

/**
 * Every yaac egress/ingress policy, as plain `networking.k8s.io/v1`
 * NetworkPolicy. The datapath these police is docs/worktree-egress.md.
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

/** Selector matching every worktree pod (the label the worktree builder stamps). */
const worktreePodSelector = {
  matchExpressions: [{ key: LABEL_WORKTREE_ID, operator: 'Exists' }],
}

/**
 * Worktree-pod EGRESS.
 *
 * This is the containment floor for every worktree, and its shape is the
 * whole fail-closed story: the ONLY world-ward rule is "the node, on
 * netd's reserved listener range". A worktree pod cannot address the
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
 * redirected traffic would get — it cannot impersonate another worktree,
 * and it still cannot reach the proxy's transparent ports (those are
 * node-only, see buildProxyIngressNpManifest).
 *
 * Two direct dials to the proxy, both to the pod itself rather than the
 * world: its DNS stub on 53/udp (which worktree pods point `dnsPolicy: None`
 * at) and its ssh-agent listener on SSH_AGENT_PORT, which the in-pod
 * forwarder re-exposes as SSH_AUTH_SOCK's UNIX socket. Neither reaches
 * anything outside the cluster, and the agent port is a signing oracle for
 * destination-constrained keys only — the proxy re-checks that the source
 * pod IP resolves to a worktree whose registered remote is SSH, and admits
 * only list/sign messages onto the shared agent.
 *
 * Deliberately NO in-cluster allowance for the per-project registry (5000)
 * or the vcluster API (8443): this policy is install-wide, so it cannot
 * express "the worktree's OWN project/vcluster" — a blanket rule would open
 * every registry and every vcluster API to every worktree (cross-project
 * image overwrite, issue #17). NetworkPolicy unions allow rules, so those
 * flows are admitted instead by the exactly-scoped per-project and
 * per-worktree policies applied at create time.
 */
export function buildWorktreeEgressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(WORKTREE_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: worktreePodSelector,
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
        ports: [udp(DNS_STUB_PORT), tcp(SSH_AGENT_PORT)],
      },
    ],
  })
}

/**
 * Worktree-pod INGRESS: only the proxy's relay dials into streamd. Before
 * the relay nothing dialed worktree pods at all, so their ingress was
 * default-allow by omission; selecting them with any ingress rule makes it
 * default-deny, which is the point.
 */
export function buildWorktreeIngressLockNpManifest(): Record<string, unknown> {
  return np(WORKTREE_INGRESS_LOCK_NP_NAME, k8sNamespace(), {
    podSelector: worktreePodSelector,
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
 * Two pod-facing ports, and only for worktree pods in this namespace (DNS
 * additionally for vcluster-synced pods in labeled vcluster namespaces):
 * the DNS stub, and the ssh-agent listener. The agent port is deliberately
 * NOT open to vcluster-synced pods — a nested install forwards its OWN
 * inner proxy's agent to its own worktrees, and the outer agent holds keys
 * that install never had.
 */
export function buildProxyIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(PROXY_INGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        // netd's Envoy (host netns) delivering redirected worktree egress,
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
        from: [{ podSelector: worktreePodSelector }],
        ports: [udp(DNS_STUB_PORT), tcp(SSH_AGENT_PORT)],
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
 * neither the proxy nor a worktree pod nor a builder.
 *
 * Plain NP has no deny verb, so this is expressed the way NP does it: an
 * empty `egress` list over a selector, which default-denies every selected
 * pod. NetworkPolicy has no deny that beats an allow, so this simply
 * unions with the scoped allows other policies grant — the exclusions
 * below are about which pods need NO egress at all, not about escaping a
 * deny.
 *
 *  - the proxy: the one pod that legitimately reaches the internet.
 *  - worktree pods: governed by buildWorktreeEgressNpManifest.
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
        { key: LABEL_WORKTREE_ID, operator: 'DoesNotExist' },
        { key: LABEL_ROLE, operator: 'NotIn', values: [ROLE_BUILDER] },
      ],
    },
    policyTypes: ['Egress'],
    egress: [],
  })
}

/**
 * The vcluster's synced-pod egress floor — the single containment policy
 * for everything running inside a per-worktree vcluster, and the one a
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
 * OWNING outer worktree pod, DNS from the vcluster's own synced pods.
 */
export function buildInnerProxyIngressNpManifest(
  vcNamespace: string,
  vcName: string,
  /** The OWNING outer worktree id — the only pod admitted to the relay. */
  ownerWorktreeId: string,
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
        // The nested server (the owning outer worktree pod, in the install
        // namespace) dials the inner proxy's pod IP directly. Other
        // worktrees stay locked out; the bearer auth line is the second gate.
        from: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': k8sNamespace() } },
          podSelector: { matchLabels: { [LABEL_WORKTREE_ID]: ownerWorktreeId } },
        }],
        ports: [tcp(RELAY)],
      },
      {
        from: [{ podSelector: { matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName } } }],
        ports: [udp(DNS_STUB_PORT)],
      },
      {
        // ssh-agent forwarding for the inner install's OWN worktrees: the
        // synced worktree pods of this vcluster reach the inner proxy's
        // agent, which holds only the keys that install uploaded. Scoped to
        // synced pods carrying a worktree id, so the vcluster's other
        // workloads (its control plane, a tenant's own pods) get nothing.
        from: [{
          podSelector: {
            matchLabels: { [LABEL_VCLUSTER_MANAGED_BY]: vcName },
            matchExpressions: [{ key: LABEL_WORKTREE_ID, operator: 'Exists' }],
          },
        }],
        ports: [tcp(SSH_AGENT_PORT)],
      },
    ],
  })
}

/**
 * Synced worktree-pod INGRESS lock — the inner counterpart of
 * buildWorktreeIngressLockNpManifest. Synced worktree pods accept streamd
 * dials from their own vcluster's inner proxies only.
 */
export function buildInnerWorktreeIngressLockNpManifest(
  vcNamespace: string,
  vcName: string,
): Record<string, unknown> {
  return np(INNER_WORKTREE_INGRESS_LOCK_NP_NAME, vcNamespace, {
    podSelector: {
      matchExpressions: [
        { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [vcName] },
        { key: LABEL_WORKTREE_ID, operator: 'Exists' },
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
