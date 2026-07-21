/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
/** Secret holding the server→proxy bearer secret. */
export const PROXY_AUTH_SECRET_NAME = 'yaac-proxy-auth'
/** Port the proxy serves inside the cluster (container + Service port). */
export const PROXY_PORT = 10255
/**
 * Transparent egress listeners: session pods' outbound 443/80 is DNAT'd
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
 * per-connection credential as HTTP(S), with no `x:<sessionId>` in the
 * workload's env.
 */
export const TRANSPARENT_TUNNEL_PORT = 10258
/**
 * Port the per-pod git SSH `ncat` ProxyCommand dials (a sentinel address, not
 * a real host). Cilium redirects egress to SSH_TUNNEL_SENTINEL:this-port
 * through the node Envoy to the proxy's transparent tunnel listener, so SSH
 * gets the same source-IP-via-PP2 identity as HTTP(S). ncat still sends
 * `CONNECT host:22`, so the proxy learns the real destination for the
 * allowlist (a raw port-22 redirect would lose the hostname — DNS is a stub).
 */
export const TUNNEL_INGRESS_PORT = 10259
/**
 * Sentinel address the SSH ncat ProxyCommand dials. Never a real host: it
 * only exists to be matched and redirected by Cilium. In the RFC2544
 * benchmark range (like the DNS stub's 198.18.0.1), so it can never route.
 */
export const SSH_TUNNEL_SENTINEL = '198.18.0.2'
/** UDP port the proxy's DNS stub serves (Service + container; needs
 * CAP_NET_BIND_SERVICE so the non-root proxy can bind <1024). */
export const DNS_STUB_PORT = 53
/** CiliumEnvoyConfig that programs the node Envoy to forward redirected
 * session egress to the proxy's transparent listeners. */
export const EGRESS_REDIRECT_CEC_NAME = 'yaac-egress-redirect'
/** CiliumNetworkPolicy that L7-redirects session-pod egress into the CEC. */
export const SESSION_EGRESS_REDIRECT_CNP_NAME = 'yaac-session-egress-redirect'
/** CiliumNetworkPolicy locking the proxy's transparent ports to Envoy/host. */
export const PROXY_INGRESS_CNP_NAME = 'yaac-proxy-ingress'
/** ServiceAccount the proxy uses to watch pods (source-IP -> session). */
export const PROXY_SA_NAME = 'yaac-proxy'

/**
 * Inner (nested / yaac-in-yaac) redirect objects. The server projects these
 * into a managed vcluster's host namespace so the vcluster's synced pods are
 * redirected to that session's *inner* proxy at higher precedence than the
 * outer redirect (see docs/nested-containers.md). The session pod
 * never gets host RBAC — the server rebuilds them from these trusted builders.
 */
export const INNER_EGRESS_REDIRECT_CEC_NAME = 'yaac-inner-egress-redirect'
export const INNER_SESSION_EGRESS_REDIRECT_CNP_NAME = 'yaac-inner-session-egress-redirect'
export const INNER_PROXY_INGRESS_CNP_NAME = 'yaac-inner-proxy-ingress'
/**
 * The outer yaac's low-precedence fallback redirect for a vcluster's synced
 * pods (→ the OUTER proxy), so they have working egress from the moment they
 * exist — before/without any inner yaac.
 *
 * The listeners live in a single SHARED, cluster-scoped
 * `CiliumClusterwideEnvoyConfig` (one per install, name install-scoped via
 * `vclusterFallbackCcecName` to avoid collisions between the real install and
 * ephemeral e2e `yaac-test-<run-id>` installs). Each vcluster keeps its own
 * fallback CNP (for tenant isolation) but references that shared CCEC, so
 * creating/destroying a vcluster adds/removes NO Envoy listeners — the churn
 * that otherwise triggers a node-wide "regenerate all endpoints" and wedges
 * every session's egress (see docs/nested-containers.md).
 *
 * One shared base name: the per-vcluster CNP uses it verbatim; the cluster-scoped
 * CCEC suffixes it with the install namespace (`vclusterFallbackCcecName`).
 */
export const VCLUSTER_FALLBACK_REDIRECT_NAME = 'yaac-vcluster-fallback-redirect'
/**
 * `toPorts.listener.priority` (lower number = higher precedence; unset is the
 * lowest, ~126). EVERY yaac's session-egress redirect uses the SAME normal
 * value — so an inner yaac is fully transparent (no special band) and its
 * projected redirect naturally beats the outer fallback. The outer's
 * vcluster-fallback uses a deliberately lower precedence so any inner override
 * wins. Spike 2026-06-16 proved lower-wins (explicit beats unset); the nesting
 * e2e pins the explicit-vs-explicit case.
 */
export const SESSION_REDIRECT_PRIORITY = 50
export const VCLUSTER_FALLBACK_PRIORITY = 90
/**
 * Role label + value the inner proxy pod carries so the inner override can
 * exclude it (loop-free): the inner proxy is NOT redirected to itself, so its
 * own upstream dials fall through to the outer redirect → outer proxy → world.
 */
export const LABEL_ROLE = 'yaac.role'
export const ROLE_INNER_PROXY = 'inner-proxy'
/**
 * Role of the ephemeral runsc builder pods that execute untrusted image
 * layers (docs/trust-split-builds.md). Referenced by the world-deny
 * exclusion below and by the builder-pod reap sweep; defined here (not in
 * builder-pod.ts) so the policy builder needs no import from lib/container.
 */
export const ROLE_BUILDER = 'builder'
/**
 * Label stamped on the host objects `reconcileInnerRedirects` projects into a
 * vcluster's namespace, so the prune pass can list exactly its own writes and
 * never touch the vcluster's egress floor (which shares the `app` label).
 * Per-install objects also carry `LABEL_DATA_DIR_HASH` = the owning inner
 * install, the prune key.
 */
export const LABEL_PROJECTION = 'yaac.projection'
export const PROJECTION_INNER_REDIRECT = 'inner-redirect'
/**
 * Nested (inner) proxy only. The inner proxy's chained upstream dial
 * (inner session → inner proxy → OUTER proxy → internet) terminates TLS at
 * the outer proxy, which presents a leaf signed by the OUTER proxy's MITM CA.
 * The stock proxy dials upstream with Node's default trust store, so without
 * the outer CA that dial fails with "self-signed certificate in certificate
 * chain" and the inner session has no internet. The server projects the outer
 * CA into the vcluster as this ConfigMap; the inner proxy mounts it and points
 * NODE_EXTRA_CA_CERTS at it (additive trust — the real roots still apply). The
 * inner yaac reads the outer CA from its own session-pod trust mount
 * (pod-spec CA_CERT_PATH).
 */
export const OUTER_CA_CONFIGMAP_NAME = 'yaac-outer-proxy-ca'

/** Blanket world-egress deny (CiliumNetworkPolicy) — see the builder. */
export const EGRESS_WORLD_DENY_NAME = 'yaac-egress-world-deny'

/** Name of the builder-role admission guard (policy + binding). */
export const BUILDER_ROLE_GUARD_NAME = 'yaac-builder-role-guard'
