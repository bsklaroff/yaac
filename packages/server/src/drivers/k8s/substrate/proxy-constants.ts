/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
/**
 * Deployment/Service name and pod selector label of the install's npm
 * registry cache (drivers/k8s/cluster/npm-cache.ts), and the port it serves —
 * one worktree pods dial directly, outside netd's redirected set.
 */
export const NPM_CACHE_APP_NAME = 'yaac-npm-cache'
export const NPM_CACHE_PORT = 4873
/**
 * Worktree-pod label admitting it to the npm cache — both policies that let
 * a worktree dial the cache select on it. Stamped by the server at launch,
 * per the project's `npmCache` setting; a worktree pod holds no API
 * credential, so it cannot relabel itself in.
 */
export const LABEL_NPM_CACHE = 'yaac.npm-cache'
/**
 * DaemonSet/ServiceAccount name and pod selector label of netd, the
 * redirect layer (features/cluster/netd.ts). Defined here with the other
 * datapath names so a caller can select on it without importing the
 * manifest builders.
 */
export const NETD_APP_NAME = 'yaac-netd'
export const NETD_SA_NAME = 'yaac-netd'
/** Secret holding the server→proxy bearer secret. */
export const PROXY_AUTH_SECRET_NAME = 'yaac-proxy-auth'
/** Port the proxy serves inside the cluster (container + Service port). */
export const PROXY_PORT = 10255
/**
 * Transparent egress listeners: worktree pods' outbound 443/80 is DNAT'd
 * here by their redirect init container (TLS-SNI / Host-header routing,
 * source-pod-IP identity — see k8s/proxy/proxy.ts).
 */
export const TRANSPARENT_HTTPS_PORT = 10256
export const TRANSPARENT_HTTP_PORT = 10257
/**
 * Transparent tunnel listener: the relay forwards SSH (git's ncat
 * ProxyCommand, pointed at the relay's loopback CONNECT port) here behind
 * a PP2 identity header. The listener verifies the token, parses the
 * `CONNECT host:port`, and tunnels — so SSH authenticates with the same
 * per-connection credential as HTTP(S), with no `x:<worktreeId>` in the
 * workload's env.
 */
export const TRANSPARENT_TUNNEL_PORT = 10258
/**
 * Port the per-pod git SSH `ncat` ProxyCommand dials (a sentinel address, not
 * a real host). netd redirects egress to SSH_TUNNEL_SENTINEL:this-port
 * through the node Envoy to the proxy's transparent tunnel listener, so SSH
 * gets the same source-IP-via-PP2 identity as HTTP(S). ncat still sends
 * `CONNECT host:22`, so the proxy learns the real destination for the
 * allowlist (a raw port-22 redirect would lose the hostname — DNS is a stub).
 */
export const TUNNEL_INGRESS_PORT = 10259
/**
 * Sentinel address the SSH ncat ProxyCommand dials. Never a real host: it
 * only exists to be matched and redirected by netd. In the RFC2544
 * benchmark range (like the DNS stub's 198.18.0.1), so it can never route.
 */
export const SSH_TUNNEL_SENTINEL = '198.18.0.2'
/** UDP port the proxy's DNS stub serves (Service + container; needs
 * CAP_NET_BIND_SERVICE so the non-root proxy can bind <1024). */
export const DNS_STUB_PORT = 53
/**
 * ssh-agent forwarding listener: the proxy speaks the ssh-agent protocol
 * here, spliced to its own in-memory agent. Worktree pods run a local
 * forwarder (socat) that re-exposes it as the UNIX socket SSH_AUTH_SOCK
 * names, so a pod's ssh client is unchanged while the rendezvous becomes a
 * TCP hop the two pods can make from different nodes — a hostPath UNIX
 * socket only meets on one.
 *
 * Reachable only by worktree pods (buildProxyIngressNpManifest admits this
 * port from the worktree selector alone), and the proxy re-checks the source
 * pod IP against its pod-watch before splicing. Key bytes stay in the proxy,
 * and the client→agent direction is filtered to identity listings and
 * signature requests — an add/remove/lock never reaches an agent every
 * worktree shares (k8s/proxy/ssh-agent-relay.ts).
 */
export const SSH_AGENT_PORT = 10261
/**
 * Relay listener: the proxy's authenticated CONNECT into worktree pods'
 * streamd (docs/stream-relay.md). The server dials it, sends one auth
 * line ({token: proxyAuthSecret, worktreeId}), and the proxy splices the
 * rest of the stream to `podIP:POD_STREAM_PORT`. The server reaches it
 * through one long-lived kubectl port-forward to the proxy Deployment
 * (see stream-relay.ts).
 */
export const RELAY_PORT = 10260
/**
 * TCP port of streamd, the in-pod stream daemon worktree pods run
 * (dockerfiles/streamd). In gVisor this is the sentry netstack, reachable
 * via the pod IP like any Service backend; only the proxy may dial it
 * (buildWorktreeIngressLockNpManifest).
 */
export const POD_STREAM_PORT = 10300
/**
 * Reserved node-local port range netd's Envoy binds its listener trio
 * in — one trio per install, not per target (see k8s/netd/ports.ts, which
 * takes the base and slot count from the DaemonSet env so the range has
 * one definition). Worktree pods' NetworkPolicy admits egress to
 * the node on exactly this range — that is the ONLY world-ward egress they
 * get, which is what makes a missing redirect fail closed rather than open.
 *
 * Reaching a listener directly is not an escalation: it only reaches
 * Envoy, which always stamps the connection's real peer address into the
 * PROXY-protocol header, so a pod cannot use it to impersonate another
 * worktree. The proxy's transparent ports stay unreachable from pods.
 */
export const NETD_LISTENER_PORT_BASE = 15100
export const NETD_LISTENER_PORT_END = 15999
/** Trios the range holds; must satisfy BASE + SLOTS*3 - 1 <= END. */
export const NETD_LISTENER_SLOTS = 300

/** NetworkPolicy default-denying world egress across the install namespace. */
export const EGRESS_WORLD_DENY_NAME = 'yaac-egress-world-deny'
/** NetworkPolicy granting worktree pods their redirect egress. */
export const WORKTREE_EGRESS_NP_NAME = 'yaac-worktree-egress'
/** NetworkPolicy locking the proxy's ingress (transparent ports = node only). */
export const PROXY_INGRESS_NP_NAME = 'yaac-proxy-ingress'
/** NetworkPolicy locking worktree-pod ingress to the proxy's relay dials. */
export const WORKTREE_INGRESS_LOCK_NP_NAME = 'yaac-worktree-ingress-lock'
/** Role label pods carry so policy and sweeps can select on what they are. */
export const LABEL_ROLE = 'yaac.role'
/**
 * Role of the ephemeral runsc builder pods that execute untrusted image
 * layers (docs/trust-split-builds.md). Referenced by the world-deny
 * exclusion and by the builder-pod reap sweep; defined here (not in
 * builder-pod.ts) so the policy builder needs no import from features/images.
 */
export const ROLE_BUILDER = 'builder'

/** ServiceAccount the proxy uses to watch pods (source-IP -> worktree). */
export const PROXY_SA_NAME = 'yaac-proxy'

/**
 * The objects the proxy is told through and reports through
 * (docs/worktree-egress.md "What the proxy is told, and how"). One writer
 * per object: the server writes the inputs, the proxy writes the outputs.
 * The proxy selects and names them by the same strings, copied into
 * k8s/proxy/objects.ts because it cannot import src/.
 *
 * Inputs carry `yaac.proxy-input=<kind>`; outputs carry
 * `yaac.proxy-output=<kind>`. Labels rather than names because the
 * informers on both sides select by label, and because `list`/`watch`
 * cannot be name-scoped anyway.
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
/** Prefix of the per-worktree registration ConfigMaps (`-<worktreeId>`). */
export const PROXY_REGISTRATION_PREFIX = 'yaac-proxy-reg'
/** Prefix of the per-project secret-values Secrets (install-scoped name). */
export const PROXY_PROJECT_SECRETS_PREFIX = 'yaac-proxy-secrets'

/**
 * Deployment/Service name, ServiceAccount and pod selector label of the
 * yaac server itself, which under this driver is a pod in the install
 * namespace rather than a process beside the cluster
 * (docs/server-in-cluster.md).
 *
 * The datapath names it in three places the server's own code applies —
 * the world-egress default-deny excludes it (a server that cannot reach
 * github clones nothing), the proxy's ingress admits its control and relay
 * dials, and its own ingress policy selects it — so the name lives in this
 * zero-import vocabulary with the rest of the datapath rather than in the
 * install feature that deploys it.
 */
export const SERVER_APP_NAME = 'yaac-server'
export const SERVER_SA_NAME = 'yaac-server'
/**
 * NetworkPolicy admitting the server pod's API from the node addresses —
 * the kubelet's readiness probe and, on kind, the fronting forwarder's
 * dial. Re-rendered by the server at attach as well as by install, since
 * the node set is the one input that changes under a running install.
 */
export const SERVER_INGRESS_NP_NAME = 'yaac-server-ingress'
/**
 * NetworkPolicy admitting the server pod's API from whatever fronts its
 * Service — the tailnet operator's proxy pod, or nothing at all on kind,
 * where the forwarder is host-networked and covered by the node addresses.
 * Install-only: the server knows nothing about frontings.
 */
export const SERVER_FRONT_INGRESS_NP_NAME = 'yaac-server-ingress-front'
/** Port the server listens on inside its pod (container + Service port). */
export const SERVER_POD_PORT = 8787
/**
 * Deployment/ConfigMap name and pod selector label of the kind fronting: a
 * hostNetwork Envoy on the control-plane node that forwards the port the
 * kind `extraPortMapping` targets into the server's ClusterIP Service.
 */
export const SERVER_FRONT_APP_NAME = 'yaac-server-front'
/**
 * Node port the kind `extraPortMapping` targets, bound by the fronting
 * forwarder. Fixed rather than allocator-assigned because the mapping is
 * written into the cluster's config at CREATE time — the two halves have
 * to agree before either exists, and coexisting installs are separate
 * clusters, so only the HOST port has to vary between them. The value is
 * the one every existing cluster's mapping already carries, which is what
 * lets a re-install converge such a cluster instead of recreating it.
 */
export const SERVER_FRONT_PORT = 30787

/**
 * Where the Tailscale Kubernetes operator lives and how it labels the proxy
 * pod it runs per exposed Service — what the tailnet fronting's ingress
 * peer selects on. The namespace is the operator chart's default and the
 * one the documented helm command installs into.
 */
export const TAILSCALE_OPERATOR_NAMESPACE = 'tailscale'
export const TAILSCALE_PARENT_RESOURCE_LABEL = 'tailscale.com/parent-resource'
export const TAILSCALE_PARENT_NAMESPACE_LABEL = 'tailscale.com/parent-resource-ns'

/**
 * `host:port` of the proxy's Service, in-cluster DNS.
 *
 * The one way anything reaches the proxy's own listeners now that the
 * server is a pod of the same namespace (docs/server-in-cluster.md): the
 * control API and the stream relay are ordinary pod-to-pod dials, admitted
 * by the proxy's ingress policy on the server's pod selector.
 *
 * A FULL `.svc.cluster.local` name for the same reason the registry uses
 * one — a worktree resolves it through the proxy's split-horizon DNS, which
 * forwards only `.cluster.local` to CoreDNS. Namespace is a parameter so
 * this stays part of the zero-import vocabulary.
 */
export function proxyServiceHost(namespace: string, port: number): string {
  return `${PROXY_APP_NAME}.${namespace}.svc.cluster.local:${String(port)}`
}

/** Name of the builder-role admission guard (policy + binding). */
export const BUILDER_ROLE_GUARD_NAME = 'yaac-builder-role-guard'
