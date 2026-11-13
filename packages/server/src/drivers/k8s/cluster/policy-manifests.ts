import { isIP } from 'node:net'
import {
  DNS_STUB_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  LABEL_WORKSPACE_ID,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_PORT_END,
  NFS_PORT,
  POD_STREAM_PORT,
  PROXY_APP_NAME,
  PROXY_EGRESS_NP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  RELAY_PORT,
  ROLE_BUILDER,
  ROLE_SERVER,
  SERVER_APP_NAME,
  SERVER_EGRESS_NP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_FRONT_PORT,
  SERVER_INGRESS_NP_NAME,
  SERVER_MAMA_PORT,
  SITE_ROUTER_APP_NAME,
  SITE_ROUTER_TAILNET_PORT,
  SERVER_POD_PORT,
  WORKSPACE_EGRESS_NP_NAME,
  WORKSPACE_INGRESS_LOCK_NP_NAME,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  k8sNamespace,
} from '#drivers/k8s/substrate'
import { MAIN_REGISTRY_APP_LABEL } from './main-registry'
import { REGISTRY_NAMESPACE, REGISTRY_SERVICE_PORT } from './registry'

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
 * Also allowed: the proxy pod's DNS stub (53/udp).
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
        ports: [udp(DNS_STUB_PORT)],
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
 * source. Workspace pods may reach only the DNS stub.
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
        ports: [udp(DNS_STUB_PORT)],
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
 * IPv4 addresses that are not publicly routable: the IANA special-purpose
 * registry (private, CGNAT, loopback, link-local, documentation,
 * benchmarking, multicast, reserved), plus Azure's WireServer, a metadata
 * service on a public address. Link-local and CGNAT hold every major cloud's
 * IPv4 metadata service. The proxy refuses the same set itself
 * (k8s/proxy/upstream.ts).
 */
export const NON_PUBLIC_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3', '168.63.129.16/32',
]

/**
 * Public IPv6: global unicast less its special-purpose blocks. Everything
 * else falls outside it, ULA (where AWS and GCE serve IPv6 metadata) and
 * link-local included.
 */
export const PUBLIC_V6 = { cidr: '2000::/3', except: ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'] }

const BUILDER_EGRESS_NP_NAME = 'yaac-builder-egress'

/** Where NodeLocal DNSCache listens in IPVS mode (typically 169.254.20.10). */
const LINK_LOCAL_V4 = '169.254.0.0/16'

/** Every port in 1..65535 but `excluded`, as NetworkPolicy port ranges. */
function portsExcept(protocol: 'TCP' | 'UDP', excluded: number[]): Array<Record<string, unknown>> {
  const ranges: Array<Record<string, unknown>> = []
  let start = 1
  for (const port of [...excluded].sort((a, b) => a - b)) {
    if (port > start) ranges.push({ protocol, port: start, endPort: port - 1 })
    start = port + 1
  }
  ranges.push({ protocol, port: start, endPort: 65535 })
  return ranges
}

/**
 * Egress to the cluster's resolver: by selector, and port 53 on its Service
 * addresses (`dnsCidrs`) and on link-local, where NodeLocal DNSCache answers
 * in its two modes.
 */
export function dnsEgress(dnsCidrs: string[]): Record<string, unknown> {
  return {
    to: [
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
      ...ipBlocks([...dnsCidrs, LINK_LOCAL_V4]),
    ],
    ports: [udp(53), tcp(53)],
  }
}

/** Whether a host CIDR lies in `PUBLIC_V6`'s 2000::/3. */
function inPublicV6(cidr: string): boolean {
  const first = parseInt(cidr.split(':')[0] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff
}

/**
 * Egress for pods that may dial the internet: builder pods (running
 * agent-editable Dockerfiles) and the proxy. Public addresses and DNS
 * (`dnsEgress`) are open. Every node address (`nodeAddressBlocks`) is cut
 * from the public block, as a cloud node's ExternalIP is public. Each is
 * cut from its own family's block, because the apiserver rejects an
 * `except` outside its block's `cidr`. Each caller adds rules for the
 * in-cluster peers it needs. Selectors match a Service dial too, as policy
 * sees the destination after kube-proxy's DNAT. Anything else internal is
 * opened only by the network operator's own policy (docs/workspace-egress.md
 * "Opening an internal destination").
 */
export function wideEgress(nodeAddrs: string[], dnsCidrs: string[]): Array<Record<string, unknown>> {
  const v6 = nodeAddrs.filter((c) => c.includes(':'))
  return [
    {
      to: [
        { ipBlock: { cidr: '0.0.0.0/0', except: [...nodeAddrs.filter((c) => !c.includes(':')), ...NON_PUBLIC_V4] } },
        { ipBlock: { cidr: PUBLIC_V6.cidr, except: [...PUBLIC_V6.except, ...v6.filter(inPublicV6)] } },
      ],
    },
    dnsEgress(dnsCidrs),
  ]
}

/**
 * Proxy EGRESS: its upstream dials, anywhere `wideEgress` allows, plus its
 * in-cluster peers: the server's mama listener, workspace pods' streamd
 * (the stream relay), and the apiserver its watches read, at its real
 * endpoints (`apiserverEndpoints`).
 *
 * It also reaches the site router's tailnet listener, for the site route
 * (docs/workspace-egress.md "Tailnet sites").
 *
 * It also reaches every node address, since a project's allowlist may name
 * one exactly and the proxy dials it for the workspace. Two ports are cut.
 * The kind fronting's node port, because that forwarder's dial into the
 * server comes from the node, which the server's ingress admits, and a
 * loopback-`Host` request arriving there is treated as the owner
 * (docs/remote-hosting.md). NFS, for a shared tier served from a node
 * (infra/hetzner-k3s): traffic to another node is SNATed to the sending
 * node's address, so the server's export list cannot tell such a pod from
 * a node's kernel mount.
 */
export function buildProxyEgressNpManifest(
  nodeAddrs: string[],
  dnsCidrs: string[],
  apiserver: { cidrs: string[]; ports: number[] },
): Record<string, unknown> {
  return np(PROXY_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Egress'],
    egress: [
      ...wideEgress(nodeAddrs, dnsCidrs),
      {
        to: ipBlocks(nodeAddrs),
        ports: [...portsExcept('TCP', [NFS_PORT, SERVER_FRONT_PORT]), ...portsExcept('UDP', [NFS_PORT])],
      },
      { to: [{ podSelector: { matchLabels: { app: SERVER_APP_NAME } } }], ports: [tcp(SERVER_MAMA_PORT)] },
      { to: [{ podSelector: workspacePodSelector }], ports: [tcp(POD_STREAM_PORT)] },
      // Workspaces' requests to tailnet sites, stamped with their owner's
      // login; the proxy refuses any other dial to this port.
      { to: [{ podSelector: { matchLabels: { app: SITE_ROUTER_APP_NAME } } }], ports: [tcp(SITE_ROUTER_TAILNET_PORT)] },
      ...(apiserver.cidrs.length > 0 ? [{ to: ipBlocks(apiserver.cidrs), ports: apiserver.ports.map(tcp) }] : []),
    ],
  })
}

/**
 * Builder egress: anywhere `wideEgress` allows, plus the main registry its
 * builds pull parents from and push layers to. No node address is open: no
 * build needs one, and from a `RUN` step it would reach the kubelet, every
 * NodePort, and on a byo cluster the machines' own daemons.
 */
export function builderEgress(nodeAddrs: string[], dnsCidrs: string[]): Array<Record<string, unknown>> {
  return [
    ...wideEgress(nodeAddrs, dnsCidrs),
    {
      to: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': REGISTRY_NAMESPACE } },
        podSelector: { matchLabels: { app: MAIN_REGISTRY_APP_LABEL } },
      }],
      ports: [tcp(REGISTRY_SERVICE_PORT)],
    },
  ]
}

/**
 * `builderEgress` on every builder pod. The world-deny policy excludes
 * builders, so this is the policy that applies to them. Applied before each
 * build and by `reconcileNodeSet` as nodes join, so a builder that waited
 * for a new node is not left reaching it.
 */
export function buildBuilderEgressNpManifest(nodeAddrs: string[], dnsCidrs: string[]): Record<string, unknown> {
  return np(BUILDER_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_BUILDER } },
    policyTypes: ['Egress'],
    egress: builderEgress(nodeAddrs, dnsCidrs),
  }, {})
}

/**
 * The host's Tor listener (`YAAC_HOST_TOR_SOCKS_URL`) as an egress rule.
 * Throws unless the URL names it by IP address, the only form a policy can
 * open. A name would leave every Tor dial to time out.
 */
function torEgress(socksUrl: string | null): Array<Record<string, unknown>> {
  if (socksUrl === null) return []
  const { hostname, port } = URL.canParse(socksUrl) ? new URL(socksUrl) : { hostname: '', port: '' }
  const host = hostname.replace(/^\[(.*)\]$/, '$1')
  if (!isIP(host)) {
    throw new Error(`YAAC_HOST_TOR_SOCKS_URL (${socksUrl}) must name the Tor listener by IP address, `
      + `the only form the server's egress policy (${SERVER_EGRESS_NP_NAME}) can open`)
  }
  return [{ to: ipBlocks([`${host}/${isIP(host) === 6 ? 128 : 32}`]), ports: [tcp(Number(port) || 1080)] }]
}

/**
 * Server-pod egress (docs/server-in-cluster.md "The server's own egress"):
 * the builders' floor, which is public addresses, DNS and the main
 * registry, plus the server's own in-cluster peers. Those are the proxy's
 * control and relay ports, the apiserver at its real endpoints, and under
 * `YAAC_USE_TOR` the host's Tor listener (`torSocksUrl`, null without Tor).
 * It keeps a git remote or endpoint URL a user names off the cluster's
 * internal addresses.
 *
 * Selects `yaac.role: server` (see ROLE_SERVER). Throws without an
 * apiserver endpoint, since that policy would cut the server off the cluster
 * it manages, and for a Tor URL that names no address (`torEgress`).
 */
export function buildServerEgressNpManifest(
  nodeAddrs: string[],
  dnsCidrs: string[],
  apiserver: { cidrs: string[]; ports: number[] },
  torSocksUrl: string | null,
): Record<string, unknown> {
  if (apiserver.cidrs.length === 0 || apiserver.ports.length === 0) {
    throw new Error('the apiserver publishes no endpoint, so the server\'s egress policy cannot admit it')
  }
  return np(SERVER_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { [LABEL_ROLE]: ROLE_SERVER } },
    policyTypes: ['Egress'],
    egress: [
      ...builderEgress(nodeAddrs, dnsCidrs),
      { to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }], ports: [tcp(PROXY_PORT), tcp(RELAY_PORT)] },
      { to: ipBlocks(apiserver.cidrs), ports: apiserver.ports.map(tcp) },
      ...torEgress(torSocksUrl),
    ],
  }, { app: SERVER_APP_NAME })
}

/**
 * Server-pod ingress, node half: the API from node addresses (kubelet probe,
 * and on kind the fronting forwarder), plus the mama-only listener from the
 * egress proxy.
 *
 * Essential for security: the server binds `0.0.0.0` and treats a
 * loopback-Host request as its owner (docs/remote-hosting.md), so these
 * policies, with the workspace, proxy and builder egress policies, keep
 * untrusted pods out. `yaac cluster check` verifies this. The proxy is
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
 *  - the server, workspace and builder pods, which have their own policies.
 *    The server stays excluded so this policy can never cut it off the
 *    apiserver before its own egress policy exists.
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
