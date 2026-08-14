/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
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


/** Name of the builder-role admission guard (policy + binding). */
export const BUILDER_ROLE_GUARD_NAME = 'yaac-builder-role-guard'
