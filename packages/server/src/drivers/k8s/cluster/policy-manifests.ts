import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  LABEL_WORKSPACE_ID,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_EGRESS_NP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  RELAY_PORT,
  ROLE_BUILDER,
  SERVER_APP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_FRONT_PORT,
  SERVER_INGRESS_NP_NAME,
  SERVER_POD_PORT,
  WORKSPACE_EGRESS_NP_NAME,
  WORKSPACE_INGRESS_LOCK_NP_NAME,
  SSH_AGENT_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  k8sNamespace,
} from '#drivers/k8s/substrate'

/**
 * Every yaac egress/ingress policy, as plain `networking.k8s.io/v1`
 * NetworkPolicy. The datapath these police is docs/workspace-egress.md.
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

/** Selector matching every workspace pod (the label the workspace builder stamps). */
const workspacePodSelector = {
  matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }],
}

/**
 * Workspace-pod EGRESS.
 *
 * This is the containment floor for every workspace, and its shape is the
 * whole fail-closed story: the ONLY world-ward rule is "the node, on
 * netd's reserved listener range". A workspace pod cannot address the
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
 * redirected traffic would get — it cannot impersonate another workspace,
 * and it still cannot reach the proxy's transparent ports (those are
 * node-only, see buildProxyIngressNpManifest).
 *
 * Two direct dials to the proxy, both to the pod itself rather than the
 * world: its DNS stub on 53/udp (which workspace pods point `dnsPolicy: None`
 * at) and its ssh-agent listener on SSH_AGENT_PORT, which the in-pod
 * forwarder re-exposes as SSH_AUTH_SOCK's UNIX socket. Neither reaches
 * anything outside the cluster, and the agent port is a signing oracle for
 * destination-constrained keys only — the proxy re-checks that the source
 * pod IP resolves to a workspace whose registered remote is SSH, and admits
 * only list/sign messages onto the shared agent.
 *
 * Nothing here for the install's npm cache: which workspaces may dial it is
 * per project, so its rule selects on a label the server stamps
 * (npm-cache.ts), and NetworkPolicy unions it with this one.
 *
 * Deliberately NO in-cluster allowance for the per-project registry (5000):
 * this policy is install-wide, so it cannot express "the workspace's OWN
 * project" — a blanket rule would open every registry to every workspace
 * (cross-project image overwrite, issue #17). NetworkPolicy unions allow
 * rules, so those flows are admitted instead by the exactly-scoped
 * per-project policies applied at create time.
 */
export function buildWorkspaceEgressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(WORKSPACE_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: workspacePodSelector,
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
 * Workspace-pod INGRESS: only the proxy's relay dials into streamd. Before
 * the relay nothing dialed workspace pods at all, so their ingress was
 * default-allow by omission; selecting them with any ingress rule makes it
 * default-deny, which is the point.
 */
export function buildWorkspaceIngressLockNpManifest(): Record<string, unknown> {
  return np(WORKSPACE_INGRESS_LOCK_NP_NAME, k8sNamespace(), {
    podSelector: workspacePodSelector,
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
 * Two pod-facing ports, and only for workspace pods in this namespace: the
 * DNS stub, and the ssh-agent listener.
 */
export function buildProxyIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(PROXY_INGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        // netd's Envoy (host netns) delivering redirected workspace egress,
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
        from: [{ podSelector: workspacePodSelector }],
        ports: [udp(DNS_STUB_PORT), tcp(SSH_AGENT_PORT)],
      },
      {
        // The in-cluster server, which reaches the same two ports the
        // host-side server reached through its port-forward — the control
        // API and the stream relay — but as an ordinary pod-to-pod dial
        // (docs/server-in-cluster.md). Selected by its app label rather
        // than admitted through the node CIDRs above, so a workspace pod
        // still cannot address either port.
        from: [{ podSelector: { matchLabels: { app: SERVER_APP_NAME } } }],
        ports: [tcp(PROXY_PORT), tcp(RELAY_PORT)],
      },
    ],
  })
}

/**
 * Egress rules for a pod that may dial anything EXCEPT the kind fronting's
 * node port: builder pods, whose `RUN` steps come from agent-editable
 * Dockerfiles, and the proxy, whose upstream is whatever a workspace's
 * allowlist names.
 *
 * The fronting forwarder is a hostNetwork listener, which no pod policy
 * covers, and its dial into the server is node-sourced — so the server's
 * own ingress policy admits whatever reaches it, and a request with a
 * loopback `Host` that got there would be the server's owner
 * (docs/remote-hosting.md). The only place to stop a pod is on its way
 * out: every node address on every port but that one, and everything else
 * as before. Workspace pods need none of this — their own egress policy
 * reaches node addresses on the netd listener range alone.
 */
export function egressAllButServerFront(nodeCidrs: string[]): Array<Record<string, unknown>> {
  return [
    { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: nodeCidrs } }, { ipBlock: { cidr: '::/0' } }] },
    {
      to: ipBlocks(nodeCidrs),
      ports: [
        { protocol: 'TCP', port: 1, endPort: SERVER_FRONT_PORT - 1 },
        { protocol: 'TCP', port: SERVER_FRONT_PORT + 1, endPort: 65535 },
        { protocol: 'UDP', port: 1, endPort: 65535 },
      ],
    },
  ]
}

/** Proxy EGRESS: its upstream dials, anywhere but the fronting's node port. */
export function buildProxyEgressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(PROXY_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Egress'],
    egress: egressAllButServerFront(nodeCidrs),
  })
}

/**
 * Server-pod INGRESS, node half: the API, from the node addresses.
 *
 * Load-bearing, not hardening. The in-cluster server binds `0.0.0.0` (a
 * pod's loopback has no reachable backend), and a request that names a
 * loopback Host without passing through `tailscale serve` is its owner
 * (docs/remote-hosting.md), so the two policies over its pod selector — this
 * one and `buildServerFrontIngressNpManifest` — are what keep an untrusted
 * pod from being that owner. Together with the workspace egress lockdown,
 * and `egressAllButServerFront` for the pods that may dial node addresses,
 * they are the whole wall, which is why `yaac cluster check` proves it on
 * every install rather than trusting that it was applied.
 *
 * An explicit allow, not an exclusion: what must never reach the server
 * is a pod, and the honest way to say so is to name nothing pod-shaped —
 * no `podSelector` in the install namespace, no pod CIDR anywhere. Two
 * flows arrive from the node addresses: the kubelet's readiness probe, and
 * on kind the fronting forwarder's dial, which is host-originated on the
 * control-plane node and so is sourced from that node's InternalIP (pod on
 * the same node) or its Calico tunnel address (pod on a worker) — the same
 * set `nodeIpBlocks()` renders for the proxy's ingress, and the same flow
 * it already admits for netd's Envoy.
 *
 * Split from the fronting half because the two change under different
 * hands: the node set changes as a pool's nodes are replaced, so the
 * SERVER re-renders this policy at attach; what fronts the Service is an
 * install decision the server never learns.
 */
export function buildServerIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(
    SERVER_INGRESS_NP_NAME,
    k8sNamespace(),
    {
      podSelector: { matchLabels: { app: SERVER_APP_NAME } },
      policyTypes: ['Ingress'],
      ingress: [{
        from: ipBlocks(nodeCidrs),
        ports: [tcp(SERVER_POD_PORT)],
      }],
    },
    { app: SERVER_APP_NAME },
  )
}

/**
 * Server-pod INGRESS, fronting half: the API, from whatever fronts its
 * Service — the tailnet operator's proxy pod, selected by namespace and
 * label. Empty on kind, where the forwarder is host-networked and covered
 * by the node half: an empty `ingress` list admits nothing, and it is
 * applied anyway so a re-install that changes fronting overwrites the old
 * peer rather than leaving it behind. NetworkPolicy unions allow rules
 * across objects, so the two halves compose.
 */
export function buildServerFrontIngressNpManifest(
  peers: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return np(
    SERVER_FRONT_INGRESS_NP_NAME,
    k8sNamespace(),
    {
      podSelector: { matchLabels: { app: SERVER_APP_NAME } },
      policyTypes: ['Ingress'],
      ingress: peers.length === 0 ? [] : [{ from: peers, ports: [tcp(SERVER_POD_PORT)] }],
    },
    { app: SERVER_APP_NAME },
  )
}

/**
 * Install-namespace world-egress default-deny for everything that is
 * neither the proxy nor a workspace pod nor a builder.
 *
 * Plain NP has no deny verb, so this is expressed the way NP does it: an
 * empty `egress` list over a selector, which default-denies every selected
 * pod. NetworkPolicy has no deny that beats an allow, so this simply
 * unions with the scoped allows other policies grant — the exclusions
 * below are about which pods need NO egress at all, not about escaping a
 * deny.
 *
 *  - the proxy: the one pod that reaches the internet on a workspace's
 *    behalf with the workspace's own allowlist applied. It
 *    also reads every Secret in this namespace (its Role, in
 *    proxy-manifests.ts — `list`/`watch` cannot be name-scoped), which is
 *    fine while the namespace holds only yaac's objects: anything else
 *    placed here would be readable by it.
 *  - the server: its egress is deliberately unrestricted, matching the
 *    host process it replaces — it clones and fetches git remotes and
 *    calls out for titles directly, and routing its own traffic through
 *    the egress proxy is not what the proxy is for (the proxy mediates
 *    UNTRUSTED code, and the server is the thing doing the mediating).
 *  - workspace pods: governed by buildWorkspaceEgressNpManifest.
 *  - builder pods: trust-split image builds fetch upstream packages and
 *    push to a registry (docs/trust-split-builds.md); their own scoped
 *    policy governs them.
 *
 * `NotIn`/`DoesNotExist` also match pods carrying no such label, so
 * registries, mocks, and anything added later stay covered by default. The
 * npm cache is one of those, and the one other pod with a way out: its own
 * policy (npm-cache.ts) admits 443 off-cluster, and what it fetches reaches
 * workspaces outside their allowlists — an accepted exception, bounded to
 * public npm content coming in (docs/workspace-egress.md).
 */
export function buildEgressWorldDenyNpManifest(): Record<string, unknown> {
  return np(EGRESS_WORLD_DENY_NAME, k8sNamespace(), {
    podSelector: {
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME, SERVER_APP_NAME] },
        { key: LABEL_WORKSPACE_ID, operator: 'DoesNotExist' },
        { key: LABEL_ROLE, operator: 'NotIn', values: [ROLE_BUILDER] },
      ],
    },
    policyTypes: ['Egress'],
    egress: [],
  })
}
