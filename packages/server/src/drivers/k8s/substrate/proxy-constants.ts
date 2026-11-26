/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
/**
 * Name and port of the install's npm registry cache
 * (drivers/k8s/cluster/npm-cache.ts), which the proxy dials for a workspace
 * whose registration names it.
 */
export const NPM_CACHE_APP_NAME = 'yaac-npm-cache'
export const NPM_CACHE_PORT = 4873
/**
 * Name of netd, the per-node DaemonSet whose relay carries sandbox traffic
 * (drivers/k8s/cluster/netd.ts).
 */
export const NETD_APP_NAME = 'yaac-netd'
export const NETD_SA_NAME = 'yaac-netd'
/**
 * The per-node disk pod (drivers/k8s/cluster/disk-pod.ts), which answers
 * each node's free space and tree sizes, and the port it answers on.
 */
export const DISK_APP_NAME = 'yaac-disk'
export const DISK_PORT = 8790
/**
 * The mountd DaemonSet (drivers/k8s/cluster/mountd.ts): mountd answers the
 * server on MOUNTD_PORT, and the arborist beside it answers only mountd, on
 * the pod's loopback.
 */
export const MOUNTD_APP_NAME = 'yaac-mountd'
export const MOUNTD_PORT = 10340
export const ARBORIST_PORT = 10341
/** Secret holding the server→proxy bearer secret. */
export const PROXY_AUTH_SECRET_NAME = 'yaac-proxy-auth'
/** Port the proxy serves inside the cluster (container + Service port). */
export const PROXY_PORT = 10255
/**
 * Port git's SSH `ncat` ProxyCommand dials on SSH_TUNNEL_SENTINEL. netshim
 * carries it to the proxy like any dial, and the proxy reads it as git's
 * `CONNECT host:22`, so it learns the real hostname for the allowlist
 * (every name in the sandbox resolves to the sinkhole, so a raw port-22
 * dial would lose it). k8s/proxy/socket-ingress.ts holds the same values.
 */
export const TUNNEL_INGRESS_PORT = 10259
/**
 * Address the SSH ncat ProxyCommand dials, only for the proxy to tell git's
 * tunnel apart. It is in the RFC 2544 benchmark range, so it names nothing.
 */
export const SSH_TUNNEL_SENTINEL = '198.18.0.2'
/**
 * The address a sandbox's DNS stub (netshim) answers every name with, and
 * the address its pods name as their resolver, so a sandbox never learns a
 * real address (docs/workspace-egress.md). In the benchmark range like the
 * SSH sentinel, so it names nothing. k8s/mountd/cmd/netshim holds it too.
 */
export const DNS_SINKHOLE = '198.18.0.1'
/**
 * The name a workspace's ssh knows the proxy's host key under
 * (`HostKeyAlias`), whichever git host it dials: the proxy ends every ssh
 * session to a project's git hosts itself (k8s/proxy/ssh-session.ts, which
 * holds the same name).
 */
export const SSH_HOST_KEY_ALIAS = 'yaac-proxy'
/**
 * TCP port of streamd, the in-pod stream daemon (dockerfiles/streamd),
 * which netd's relay reaches through the pod's `ingress.sock`.
 */
export const POD_STREAM_PORT = 10300
/**
 * The socket datapath (docs/workspace-egress.md). A sandbox's netshim takes
 * every TCP dial on NETSHIM_TCP_PORT and every DNS query on
 * NETSHIM_DNS_PORT, both on the sandbox's loopback, and carries each
 * connection to netd's relay through `egress.sock`. The relay hands it to
 * the proxy on SOCKET_EGRESS_PORT behind a PROXY protocol v2 header that
 * names the sandbox. The server reaches a workspace's streamd through the
 * relay on NETD_STREAM_PORT, and the site router a release on
 * NETD_SITE_PORT. k8s/proxy and k8s/mountd mirror these values.
 */
export const SOCKET_EGRESS_PORT = 10261
export const NETD_STREAM_PORT = 10262
export const NETD_SITE_PORT = 10263
export const NETSHIM_TCP_PORT = 10301
export const NETSHIM_DNS_PORT = 10302
/**
 * PROXY protocol v2 TLV types the relay adds on its header to the proxy:
 * the workspace or build id, and the proxy auth secret. The router's header
 * to the relay carries the site id under PP2_TLV_ID.
 */
export const PP2_TLV_ID = 0xe0
export const PP2_TLV_SECRET = 0xe1

/** NetworkPolicy default-denying world egress across the install namespace. */
export const EGRESS_WORLD_DENY_NAME = 'yaac-egress-world-deny'
/** NetworkPolicy locking the proxy's ingress to netd's relay and the server. */
export const PROXY_INGRESS_NP_NAME = 'yaac-proxy-ingress'
/** NetworkPolicy keeping the proxy off non-public addresses but its peers, and off the kind fronting's node port and node NFS. */
export const PROXY_EGRESS_NP_NAME = 'yaac-proxy-egress'
/** NetworkPolicies admitting netd's relay its callers and its peers. */
export const NETD_INGRESS_NP_NAME = 'yaac-netd-ingress'
export const NETD_EGRESS_NP_NAME = 'yaac-netd-egress'
/** Role label pods carry so policy and sweeps can select on what they are. */
export const LABEL_ROLE = 'yaac.role'
/**
 * Role of the ephemeral runsc builder pods that run untrusted image layers
 * (docs/image-builds.md). Used by network policy and the builder-pod
 * sweep.
 */
export const ROLE_BUILDER = 'builder'
/**
 * Role of the server pod, which its egress policy selects on. A role rather
 * than `app` so `yaac cluster check` can run a probe pod under that policy
 * without it joining the server's Service or being adopted by its
 * ReplicaSet.
 */
export const ROLE_SERVER = 'server'

/** ServiceAccount the proxy uses to watch pods (source-IP -> workspace). */
export const PROXY_SA_NAME = 'yaac-proxy'

/**
 * Objects the server uses to configure the proxy (inputs, labeled
 * `yaac.proxy-input=<kind>`) and the proxy uses to report back (outputs,
 * `yaac.proxy-output=<kind>`); see docs/workspace-egress.md. Each has one
 * writer. The strings are copied into k8s/proxy/objects.ts, which cannot
 * import src/. Informers on both sides select by label.
 */
export const LABEL_PROXY_INPUT = 'yaac.proxy-input'
export const LABEL_PROXY_OUTPUT = 'yaac.proxy-output'
/** Secret: the tool credential files and the ssh keys, replaced whole. */
export const PROXY_CREDENTIALS_SECRET_NAME = 'yaac-proxy-credentials'
/** Secret the proxy writes captured OAuth rotations into. */
export const PROXY_REFRESHED_SECRET_NAME = 'yaac-proxy-refreshed'
/**
 * A credential owner key, as the pattern source. The proxy reads a
 * credentials or refreshed Secret key up to its first `.` as the owner, so a
 * key may not contain one; must match k8s/proxy/objects.ts.
 */
export const PROXY_OWNER_KEY_PATTERN = '[\\w-]+'
/** Secret the proxy keeps its CA (and the combined trust bundle) in. */
export const PROXY_CA_SECRET_NAME = 'yaac-proxy-ca'
/** ConfigMap the proxy writes its blocked-host and git-auth records to. */
export const PROXY_STATE_CONFIGMAP_NAME = 'yaac-proxy-state'
/** Prefix of the per-workspace registration ConfigMaps (`-<workspaceId>`). */
export const PROXY_REGISTRATION_PREFIX = 'yaac-proxy-reg'
/** Prefix of the per-project secret-values Secrets (install-scoped name). */
export const PROXY_PROJECT_SECRETS_PREFIX = 'yaac-proxy-secrets'
/** Prefix of the per-project run-secrets Secrets, which workspace pods read
 *  and the proxy does not (docs/project-config.md "Run secrets"). */
export const RUN_SECRETS_PREFIX = 'yaac-run-secrets'

/**
 * Name of the yaac server's own Deployment, Service and ServiceAccount in
 * the install namespace (docs/server-in-cluster.md). Network policies
 * select on it: world-egress deny excludes it, and the proxy's and main
 * registry's ingress admit its dials.
 */
export const SERVER_APP_NAME = 'yaac-server'
export const SERVER_SA_NAME = 'yaac-server'
/**
 * NetworkPolicy admitting the server pod's API from node addresses (the
 * kubelet's readiness probe and, on kind, the fronting forwarder), and its
 * mama listener from the proxy. Both install and server start apply it,
 * since nodes can be added later.
 */
export const SERVER_INGRESS_NP_NAME = 'yaac-server-ingress'
/**
 * NetworkPolicy admitting the server pod's API from whatever fronts its
 * Service, such as the Tailscale operator's proxy pod. Applied by install
 * only. On kind the host-networked forwarder is covered by the node policy.
 */
export const SERVER_FRONT_INGRESS_NP_NAME = 'yaac-server-ingress-front'
/** NetworkPolicy keeping the server's own dials off non-public addresses but its peers. */
export const SERVER_EGRESS_NP_NAME = 'yaac-server-egress'
/** Port the server listens on inside its pod (container + Service port). */
export const SERVER_POD_PORT = 8787
/**
 * The server's second listener, which serves only the `yaac-mama` calls the
 * egress proxy relays for workspace pods, and the Service the proxy reaches
 * it at. A port of its own so the server's ingress policy can admit the
 * proxy here without admitting it to the API (docs/workspace-egress.md).
 */
export const SERVER_MAMA_PORT = 8788
/**
 * The server's token listener inside its pod (docs/remote-hosting.md
 * "Token access"), which admits a caller by bearer token alone, so its
 * ingress policy admits any source to this port and nothing else.
 */
export const SERVER_TOKEN_PORT = 8789
/** The Service that exposes SERVER_TOKEN_PORT at the address the admin
 *  named, and the NetworkPolicy that opens the port to any source. */
export const SERVER_TOKEN_SERVICE_NAME = 'yaac-server-token'
export const SERVER_TOKEN_INGRESS_NP_NAME = 'yaac-server-ingress-token'
/** The Secret holding the token listener's `tls.crt` and `tls.key`. */
export const SERVER_TOKEN_TLS_SECRET = 'yaac-server-token-tls'
export const SERVER_MAMA_SERVICE_NAME = 'yaac-server-mama'
/**
 * Deployment/ConfigMap name and pod selector label of the kind fronting: a
 * hostNetwork Envoy on the control-plane node that forwards the port the
 * kind `extraPortMapping` targets into the server's ClusterIP Service.
 */
export const SERVER_FRONT_APP_NAME = 'yaac-server-front'
/**
 * Node port the kind `extraPortMapping` targets, bound by the fronting
 * forwarder. Fixed because the mapping is written into the kind config at
 * cluster creation. Separate installs are separate clusters, so only the
 * host port differs. Changing it would force existing clusters to be
 * recreated.
 */
export const SERVER_FRONT_PORT = 30787

/**
 * The NFS port. A shared-tier NFS server trusts whatever uid a client
 * claims, so no yaac pod may dial it; when it runs on a node, the
 * policies that admit node addresses leave this port out.
 */
export const NFS_PORT = 2049

/**
 * The Tailscale operator's namespace (its chart default) and the labels it
 * puts on the proxy pod for each exposed Service. The tailnet fronting's
 * ingress policy selects on these.
 */
export const TAILSCALE_OPERATOR_NAMESPACE = 'tailscale'
export const TAILSCALE_PARENT_RESOURCE_LABEL = 'tailscale.com/parent-resource'
export const TAILSCALE_PARENT_NAMESPACE_LABEL = 'tailscale.com/parent-resource-ns'

/**
 * `host:port` of the proxy's Service in cluster DNS, used for the server's
 * control API dials. The name is fully qualified so it resolves whatever
 * the dialing pod's DNS search path.
 */
export function proxyServiceHost(namespace: string, port: number): string {
  return `${PROXY_APP_NAME}.${namespace}.svc.cluster.local:${String(port)}`
}

/** Name of the builder-role admission guard (policy + binding). */
export const BUILDER_ROLE_GUARD_NAME = 'yaac-builder-role-guard'

/**
 * The public-site edge (docs/public-sites.md). Internet traffic reaches a
 * site's release through these two Deployments and never through the
 * server: cloudflared dials out to Cloudflare, and hands each request to
 * the router, an Envoy that picks the site by `Host`.
 */
export const SITE_TUNNEL_CLOUDFLARE_APP_NAME = 'yaac-site-tunnel-cloudflare'
export const SITE_ROUTER_APP_NAME = 'yaac-site-router'
/** The Secret holding the Cloudflare tunnel's token, key `token`. */
export const SITE_TUNNEL_CLOUDFLARE_SECRET_NAME = 'yaac-site-tunnel-cloudflare'
/** cloudflared's metrics listener, whose `/ready` answers 200 while the
 *  tunnel holds a connection to Cloudflare. */
export const SITE_TUNNEL_CLOUDFLARE_METRICS_PORT = 2000
/** The router's listener (container and Service port), the origin every
 *  public hostname points at in the Cloudflare dashboard. */
export const SITE_ROUTER_PORT = 8080
/**
 * The router's tailnet listener, which serves only tailnet sites and only
 * requests carrying a tailnet login, from the tailnet tunnel alone
 * (docs/public-sites.md "Tailnet sites").
 */
export const SITE_ROUTER_TAILNET_PORT = 8081
/** The tailnet tunnel: tailscaled and tailgate in one pod, one tailnet device. */
export const SITE_TUNNEL_TAILNET_APP_NAME = 'yaac-site-tunnel-tailnet'
/** The Secret holding the site domain's wildcard certificate, which the
 *  admin or cert-manager fills (keys `tls.crt`, `tls.key`). */
export const SITE_TUNNEL_TAILNET_TLS_SECRET_NAME = 'yaac-site-tunnel-tailnet-tls'
/** The router's Envoy admin listener, for its readiness probe. */
export const SITE_ROUTER_ADMIN_PORT = 9901
/** The ConfigMap of the router's route table, which the server writes. */
export const SITE_ROUTES_CONFIGMAP_NAME = 'yaac-site-routes'
/**
 * Label every release pod of a site carries from launch, naming the site,
 * which tells the server a release apart (its handle's `siteId`, and the
 * ports it may forward). The proxy knows a release by its registration's
 * `release` instead.
 */
export const LABEL_SITE_ID = 'yaac.site-id'

/** A site's headless Service, which names its live release and resolves
 *  to netd on that release's node (cluster/site-edge.ts). */
export function siteServiceName(siteId: string): string {
  return `yaac-site-${siteId}`
}
