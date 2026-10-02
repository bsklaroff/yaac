/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
/**
 * Name and port of the install's npm registry cache
 * (drivers/k8s/cluster/npm-cache.ts). Workspace pods dial it directly, not
 * through netd's redirect.
 */
export const NPM_CACHE_APP_NAME = 'yaac-npm-cache'
export const NPM_CACHE_PORT = 4873
/**
 * Workspace-pod label that lets the pod reach the npm cache. The server
 * sets it at launch from the project's `npmCache` setting; pods have no API
 * credential, so they cannot add it themselves.
 */
export const LABEL_NPM_CACHE = 'yaac.npm-cache'
/**
 * Name of netd, the per-node egress redirect DaemonSet
 * (drivers/k8s/cluster/netd.ts).
 */
export const NETD_APP_NAME = 'yaac-netd'
export const NETD_SA_NAME = 'yaac-netd'
/** Secret holding the server→proxy bearer secret. */
export const PROXY_AUTH_SECRET_NAME = 'yaac-proxy-auth'
/** Port the proxy serves inside the cluster (container + Service port). */
export const PROXY_PORT = 10255
/**
 * Transparent egress listeners. netd redirects workspace pods' outbound
 * 443/80 here, routed by TLS SNI or Host header, with the source pod
 * identified by IP (k8s/proxy/transparent.ts).
 */
export const TRANSPARENT_HTTPS_PORT = 10256
export const TRANSPARENT_HTTP_PORT = 10257
/**
 * Transparent tunnel listener for git over SSH. netd forwards the pod's
 * `CONNECT host:port` here with a PROXY-protocol (PP2) header identifying
 * the source pod, so SSH gets the same per-pod identity as HTTP(S).
 */
export const TRANSPARENT_TUNNEL_PORT = 10258
/**
 * Port git's SSH `ncat` ProxyCommand dials on SSH_TUNNEL_SENTINEL. netd
 * redirects it through the node Envoy to the proxy's tunnel listener.
 * ncat sends `CONNECT host:22`, so the proxy learns the real hostname for
 * the allowlist (DNS in the pod is a stub, so a raw port-22 redirect
 * would lose it).
 */
export const TUNNEL_INGRESS_PORT = 10259
/**
 * Address the SSH ncat ProxyCommand dials, only for netd to match and
 * redirect. It is in the RFC 2544 benchmark range, so it never routes. It
 * must stay outside every pod CIDR: netd skips pod-CIDR destinations before
 * it reaches the sentinel rule.
 */
export const SSH_TUNNEL_SENTINEL = '198.18.0.2'
/** UDP port of the proxy's DNS stub (needs CAP_NET_BIND_SERVICE). */
export const DNS_STUB_PORT = 53
/**
 * ssh-agent listener backed by the proxy's in-memory agent. Workspace pods
 * run socat to expose it as the `SSH_AUTH_SOCK` UNIX socket, which works
 * across nodes. Only workspace pods may connect, and the proxy re-checks
 * the source pod IP. Keys stay in the proxy, and only identity listings
 * and sign requests pass through (k8s/proxy/ssh-agent-relay.ts).
 */
export const SSH_AGENT_PORT = 10261
/**
 * Relay listener: the server dials it through the proxy's Service, sends
 * one auth line (`{token, workspaceId}`), and the proxy splices the rest of
 * the stream to the pod's streamd (docs/stream-relay.md).
 */
export const RELAY_PORT = 10260
/**
 * TCP port of streamd, the in-pod stream daemon (dockerfiles/streamd).
 * Only the proxy may dial it (buildWorkspaceIngressLockNpManifest).
 */
export const POD_STREAM_PORT = 10300
/**
 * Node port range where netd's Envoy binds one listener trio per install
 * (k8s/netd/ports.ts reads the base and slot count from the DaemonSet env).
 * This range is the only outbound egress workspace pods' NetworkPolicy
 * allows, so a missing redirect fails closed. Dialing a listener directly
 * gains nothing: Envoy always stamps the real peer address in the
 * PROXY-protocol header.
 */
export const NETD_LISTENER_PORT_BASE = 15100
export const NETD_LISTENER_PORT_END = 15999
/** Trios the range holds; must satisfy BASE + SLOTS*3 - 1 <= END. */
export const NETD_LISTENER_SLOTS = 300

/** NetworkPolicy default-denying world egress across the install namespace. */
export const EGRESS_WORLD_DENY_NAME = 'yaac-egress-world-deny'
/** NetworkPolicy granting workspace pods their redirect egress. */
export const WORKSPACE_EGRESS_NP_NAME = 'yaac-workspace-egress'
/** NetworkPolicy locking the proxy's ingress (transparent ports = node only). */
export const PROXY_INGRESS_NP_NAME = 'yaac-proxy-ingress'
/** NetworkPolicy blocking the proxy from dialing the kind fronting's node port. */
export const PROXY_EGRESS_NP_NAME = 'yaac-proxy-egress'
/** NetworkPolicy locking workspace-pod ingress to the proxy's relay dials. */
export const WORKSPACE_INGRESS_LOCK_NP_NAME = 'yaac-workspace-ingress-lock'
/** Role label pods carry so policy and sweeps can select on what they are. */
export const LABEL_ROLE = 'yaac.role'
/**
 * Role of the ephemeral runsc builder pods that run untrusted image layers
 * (docs/trust-split-builds.md). Used by network policy and the builder-pod
 * sweep.
 */
export const ROLE_BUILDER = 'builder'

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
/** Secret the proxy keeps its CA (and the combined trust bundle) in. */
export const PROXY_CA_SECRET_NAME = 'yaac-proxy-ca'
/** ConfigMap the proxy writes its blocked-host and git-auth records to. */
export const PROXY_STATE_CONFIGMAP_NAME = 'yaac-proxy-state'
/** Prefix of the per-workspace registration ConfigMaps (`-<workspaceId>`). */
export const PROXY_REGISTRATION_PREFIX = 'yaac-proxy-reg'
/** Prefix of the per-project secret-values Secrets (install-scoped name). */
export const PROXY_PROJECT_SECRETS_PREFIX = 'yaac-proxy-secrets'

/**
 * Name of the yaac server's own Deployment, Service and ServiceAccount in
 * the install namespace (docs/server-in-cluster.md). Network policies
 * select on it: world-egress deny excludes it, and the proxy's ingress
 * admits its dials.
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
/** Port the server listens on inside its pod (container + Service port). */
export const SERVER_POD_PORT = 8787
/**
 * The server's second listener, which serves only the `yaac-mama` calls the
 * egress proxy relays for workspace pods, and the Service the proxy reaches
 * it at. A port of its own so the server's ingress policy can admit the
 * proxy here without admitting it to the API (docs/workspace-egress.md).
 */
export const SERVER_MAMA_PORT = 8788
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
 * The Tailscale operator's namespace (its chart default) and the labels it
 * puts on the proxy pod for each exposed Service. The tailnet fronting's
 * ingress policy selects on these.
 */
export const TAILSCALE_OPERATOR_NAMESPACE = 'tailscale'
export const TAILSCALE_PARENT_RESOURCE_LABEL = 'tailscale.com/parent-resource'
export const TAILSCALE_PARENT_NAMESPACE_LABEL = 'tailscale.com/parent-resource-ns'

/**
 * `host:port` of the proxy's Service in cluster DNS, used for the server's
 * control API and stream relay dials. The name is fully qualified because
 * the proxy's DNS stub forwards only `.cluster.local` names to CoreDNS.
 */
export function proxyServiceHost(namespace: string, port: number): string {
  return `${PROXY_APP_NAME}.${namespace}.svc.cluster.local:${String(port)}`
}

/** Name of the builder-role admission guard (policy + binding). */
export const BUILDER_ROLE_GUARD_NAME = 'yaac-builder-role-guard'
