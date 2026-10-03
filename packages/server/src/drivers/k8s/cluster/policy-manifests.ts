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
  SERVER_MAMA_PORT,
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
 * Every yaac network policy, as plain `networking.k8s.io/v1` NetworkPolicy
 * (docs/workspace-egress.md). Plain NP because every backend enforces it,
 * including managed clusters where Calico CRDs are unavailable.
 *
 * Traffic to or from the node (netd's Envoy, kubelet probes, containerd
 * pulls) uses an `ipBlock` of node addresses (`nodeIpBlocks()`), since NP
 * has no selector for the host network namespace. The builders are pure;
 * CIDRs are passed in.
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

/** Selector matching every workspace pod. */
const workspacePodSelector = {
  matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }],
}

/**
 * Workspace-pod egress: the containment floor. The only outbound rule is
 * the node on netd's listener range, so if netd has not programmed a pod's
 * redirect, its traffic is dropped. A broken netd cuts egress; it never
 * grants it.
 *
 * Dialing a listener directly is harmless: Envoy records the real source
 * address in the PROXY-protocol header, and the proxy's transparent ports
 * are node-only (buildProxyIngressNpManifest).
 *
 * Also allowed: the proxy pod's DNS stub (53/udp) and ssh-agent port. The
 * proxy only signs for workspaces whose remote is SSH, and only allows
 * list/sign requests.
 *
 * The npm cache and per-project registries are allowed by their own
 * label-scoped policies. This install-wide policy cannot scope to one
 * project, and a blanket rule would let workspaces overwrite each other's
 * images (issue #17).
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
 * Workspace-pod ingress: only the proxy's relay may dial in (to streamd).
 * Having any ingress rule makes everything else default-deny.
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
 * Proxy ingress. The transparent ports are open only to node addresses,
 * where netd's Envoy delivers from, so no pod can forge a PROXY-protocol
 * source. Workspace pods may reach only the DNS stub and ssh-agent ports.
 * The control API and relay are open to the node and to the in-cluster
 * server pod.
 */
export function buildProxyIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(PROXY_INGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        // netd's Envoy, the kubelet probe, and any node-local server.
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
        // The in-cluster server (docs/server-in-cluster.md), by label.
        from: [{ podSelector: { matchLabels: { app: SERVER_APP_NAME } } }],
        ports: [tcp(PROXY_PORT), tcp(RELAY_PORT)],
      },
    ],
  })
}

/**
 * Egress for pods that may dial anything except the kind fronting's node
 * port: builder pods (running agent-editable Dockerfiles) and the proxy.
 * That forwarder's dial into the server comes from the node, which the
 * server's ingress admits, and a loopback-`Host` request arriving there is
 * treated as the owner (docs/remote-hosting.md). So pods must be stopped on
 * the way out.
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
 * Server-pod ingress, node half: the API from node addresses (kubelet probe,
 * and on kind the fronting forwarder), plus the mama-only listener from the
 * egress proxy.
 *
 * Essential for security: the server binds `0.0.0.0` and treats a
 * loopback-Host request as its owner (docs/remote-hosting.md), so these
 * policies, with the workspace egress policy and `egressAllButServerFront`,
 * keep untrusted pods out. `yaac cluster check` verifies this. The proxy is
 * admitted only to SERVER_MAMA_PORT, never to the API: it forwards workspace
 * traffic, so a workspace could otherwise reach the API through it.
 *
 * Separate from the fronting half because the server's node-sync re-renders
 * this one when the node set changes, while fronting is fixed at install.
 */
export function buildServerIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(
    SERVER_INGRESS_NP_NAME,
    k8sNamespace(),
    {
      podSelector: { matchLabels: { app: SERVER_APP_NAME } },
      policyTypes: ['Ingress'],
      ingress: [
        { from: ipBlocks(nodeCidrs), ports: [tcp(SERVER_POD_PORT)] },
        {
          from: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
          ports: [tcp(SERVER_MAMA_PORT)],
        },
      ],
    },
    { app: SERVER_APP_NAME },
  )
}

/**
 * Server-pod ingress, fronting half: the API from whatever fronts the
 * Service (the tailnet operator's proxy pod). Empty on kind (the node half
 * covers it), but still applied so a re-install replaces an old peer.
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
 * Default-deny egress (an empty `egress` list) for every pod in the install
 * namespace except:
 *  - the proxy, which dials upstream under each workspace's allowlist (it
 *    can read every Secret in this namespace, so keep only yaac objects
 *    here);
 *  - the server, whose egress is unrestricted (git, title model downloads);
 *  - workspace and builder pods, which have their own policies.
 *
 * Pods without these labels (registries, mocks, future pods) are covered by
 * default. Other policies' allows still apply, e.g. the npm cache's 443
 * (docs/workspace-egress.md).
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
