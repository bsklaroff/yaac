import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  LABEL_WORKTREE_ID,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  RELAY_PORT,
  ROLE_BUILDER,
  WORKTREE_EGRESS_NP_NAME,
  WORKTREE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
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
 * Deliberately NO in-cluster allowance for the per-project registry (5000):
 * this policy is install-wide, so it cannot express "the worktree's OWN
 * project" — a blanket rule would open every registry to every worktree
 * (cross-project image overwrite, issue #17). NetworkPolicy unions allow
 * rules, so those flows are admitted instead by the exactly-scoped
 * per-project policies applied at create time.
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
 * Two pod-facing ports, and only for worktree pods in this namespace: the
 * DNS stub, and the ssh-agent listener.
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
