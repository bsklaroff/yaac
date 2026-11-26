import { isIP } from 'node:net'
import {
  DISK_APP_NAME,
  DISK_PORT,
  MOUNTD_APP_NAME,
  MOUNTD_PORT,
  EGRESS_WORLD_DENY_NAME,
  LABEL_ROLE,
  NETD_APP_NAME,
  NETD_EGRESS_NP_NAME,
  NETD_INGRESS_NP_NAME,
  NETD_SITE_PORT,
  NETD_STREAM_PORT,
  NFS_PORT,
  NPM_CACHE_APP_NAME,
  NPM_CACHE_PORT,
  PROXY_APP_NAME,
  PROXY_EGRESS_NP_NAME,
  PROXY_INGRESS_NP_NAME,
  PROXY_PORT,
  ROLE_SERVER,
  SERVER_APP_NAME,
  SERVER_EGRESS_NP_NAME,
  SERVER_FRONT_INGRESS_NP_NAME,
  SERVER_FRONT_PORT,
  SERVER_INGRESS_NP_NAME,
  SERVER_MAMA_PORT,
  SERVER_TOKEN_INGRESS_NP_NAME,
  SERVER_TOKEN_PORT,
  SERVER_POD_PORT,
  SITE_ROUTER_APP_NAME,
  SOCKET_EGRESS_PORT,
  k8sNamespace,
} from '#drivers/k8s/substrate'
import { MAIN_REGISTRY_APP_LABEL } from './main-registry'
import { REGISTRY_NAMESPACE, REGISTRY_POD_PORT } from './registry'

/**
 * Every yaac network policy, as plain `networking.k8s.io/v1` NetworkPolicy
 * (docs/workspace-egress.md). Plain NP because every backend enforces it,
 * including managed clusters where Calico CRDs are unavailable.
 *
 * Workspace and builder pods have no network interface and so no policy
 * of their own: the world-deny policy covers them, and everything they
 * send crosses netd's relay and the proxy, whose policies are below.
 *
 * Traffic to or from the node (kubelet probes, containerd pulls) uses an
 * `ipBlock` of node addresses (`nodeIpBlocks()`), since NP has no selector
 * for the host network namespace. The builders are pure; CIDRs are passed
 * in.
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

/**
 * The policies the redirect datapath wrote, which the server deletes by
 * name at start (docs/legacy-compat-shims.md "The redirect's policies").
 * Per-site policies go with the site sync's prune.
 */
export const RETIRED_POLICY_NAMES = [
  'yaac-workspace-egress', 'yaac-workspace-ingress-lock', 'yaac-builder-egress', 'yaac-npm-cache-workspace-egress',
]

/**
 * Proxy ingress: netd's relay on the socket egress port, where every
 * sandbox's traffic arrives, and the control API from the in-cluster
 * server and from the node, for the kubelet's readiness probe. The relay
 * sends the proxy auth secret on every connection, so the port admits no
 * one by position alone.
 */
export function buildProxyIngressNpManifest(nodeCidrs: string[]): Record<string, unknown> {
  return np(PROXY_INGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: PROXY_APP_NAME } },
    policyTypes: ['Ingress'],
    ingress: [
      { from: [{ podSelector: { matchLabels: { app: NETD_APP_NAME } } }], ports: [tcp(SOCKET_EGRESS_PORT)] },
      {
        from: [...ipBlocks(nodeCidrs), { podSelector: { matchLabels: { app: SERVER_APP_NAME } } }],
        ports: [tcp(PROXY_PORT)],
      },
    ],
  })
}

/**
 * netd ingress: the server's stream dials into workspaces on the relay's
 * stream port, and the site router's requests to releases on its site port
 * (docs/stream-relay.md, docs/public-sites.md "The router"). The site port
 * takes no secret, so this policy is what keeps everything but the router
 * off it.
 */
export function buildNetdIngressNpManifest(): Record<string, unknown> {
  return np(NETD_INGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: NETD_APP_NAME } },
    policyTypes: ['Ingress'],
    ingress: [
      { from: [{ podSelector: { matchLabels: { app: SERVER_APP_NAME } } }], ports: [tcp(NETD_STREAM_PORT)] },
      { from: [{ podSelector: { matchLabels: { app: SITE_ROUTER_APP_NAME } } }], ports: [tcp(NETD_SITE_PORT)] },
    ],
  }, { app: NETD_APP_NAME })
}

/**
 * netd egress: the proxy's socket egress port, which the relay hands every
 * sandbox connection to, the apiserver its pod and Service watches read,
 * and DNS for the proxy's name.
 */
export function buildNetdEgressNpManifest(
  dnsCidrs: string[],
  apiserver: { cidrs: string[]; ports: number[] },
): Record<string, unknown> {
  return np(NETD_EGRESS_NP_NAME, k8sNamespace(), {
    podSelector: { matchLabels: { app: NETD_APP_NAME } },
    policyTypes: ['Egress'],
    egress: [
      { to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }], ports: [tcp(SOCKET_EGRESS_PORT)] },
      dnsEgress(dnsCidrs),
      ...(apiserver.cidrs.length > 0 ? [{ to: ipBlocks(apiserver.cidrs), ports: apiserver.ports.map(tcp) }] : []),
    ],
  }, { app: NETD_APP_NAME })
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
 * Egress for pods that may dial the internet: the proxy and the server. Public addresses and DNS
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
 * in-cluster peers: the server's mama listener, the apiserver its watches
 * read, at its real endpoints (`apiserverEndpoints`), and the two install
 * services a registration may name as `clusterServices`, the npm cache and
 * the main registry's pod port. The proxy refuses either by name unless the
 * registration holds it (k8s/proxy/upstream.ts `isInstallServiceName`).
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
      { to: [{ podSelector: { matchLabels: { app: NPM_CACHE_APP_NAME } } }], ports: [tcp(NPM_CACHE_PORT)] },
      registryEgress(),
      ...(apiserver.cidrs.length > 0 ? [{ to: ipBlocks(apiserver.cidrs), ports: apiserver.ports.map(tcp) }] : []),
    ],
  })
}

/** The main registry's pod port (docs/image-builds.md "The gate"), by selector. */
function registryEgress(): Record<string, unknown> {
  return {
    to: [{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': REGISTRY_NAMESPACE } },
      podSelector: { matchLabels: { app: MAIN_REGISTRY_APP_LABEL } },
    }],
    ports: [tcp(REGISTRY_POD_PORT)],
  }
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
 * public addresses, DNS and the main registry's pod port, plus the server's
 * own in-cluster peers. Those are the proxy's control port, netd's stream
 * port (docs/stream-relay.md), the apiserver at its real endpoints, and under
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
      ...wideEgress(nodeAddrs, dnsCidrs),
      registryEgress(),
      { to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }], ports: [tcp(PROXY_PORT)] },
      { to: [{ podSelector: { matchLabels: { app: NETD_APP_NAME } } }], ports: [tcp(NETD_STREAM_PORT)] },
      // Each node's disk pod (disk-pod.ts), asked for its free space.
      { to: [{ podSelector: { matchLabels: { app: DISK_APP_NAME } } }], ports: [tcp(DISK_PORT)] },
      // Each node's agent (mountd.ts), which binds workspaces.
      { to: [{ podSelector: { matchLabels: { app: MOUNTD_APP_NAME } } }], ports: [tcp(MOUNTD_PORT)] },
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
 * policies, with the proxy's egress policy, keep untrusted traffic out. `yaac cluster check` verifies this. The proxy is
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
 * Server-pod ingress, token half: the token listener from any source
 * (docs/remote-hosting.md "Token access"). Its callers' addresses are not
 * predictable (a kind NodePort arrives from the host's), and none needs to
 * be, since the listener admits no request without a token; every other
 * port stays as the other two policies leave it.
 */
export function buildServerTokenIngressNpManifest(): Record<string, unknown> {
  return np(
    SERVER_TOKEN_INGRESS_NP_NAME,
    k8sNamespace(),
    {
      podSelector: { matchLabels: { app: SERVER_APP_NAME } },
      policyTypes: ['Ingress'],
      ingress: [{ ports: [tcp(SERVER_TOKEN_PORT)] }],
    },
    { app: SERVER_APP_NAME },
  )
}

/**
 * Server-pod ingress, fronting half: the API from whatever fronts the
 * Service (the tailnet operator's proxy pod, and the tailnet site tunnel
 * while the install names a server name). Empty on kind with no server
 * name (the node half covers it), but still applied so a re-install
 * replaces an old peer.
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
 *  - the server, which has its own policy, and stays excluded so this one
 *    can never cut it off the apiserver before its own exists.
 *
 * Every other pod is covered, workspace and builder pods included, which
 * have no interface to send from anyway. Other policies' allows still
 * apply, e.g. the npm cache's 443 (docs/workspace-egress.md).
 */
export function buildEgressWorldDenyNpManifest(): Record<string, unknown> {
  return np(EGRESS_WORLD_DENY_NAME, k8sNamespace(), {
    podSelector: {
      matchExpressions: [
        { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME, SERVER_APP_NAME] },
      ],
    },
    policyTypes: ['Egress'],
    egress: [],
  })
}
