import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { ensureCiliumCrds } from '@/lib/k8s/cilium-crds'
import {
  CA_BUNDLE_KEY,
  CA_CERT_PATH,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
} from '@/lib/k8s/pod-spec'
import { LABEL_SESSION_ID } from '@/lib/k8s/pods'
import { credentialsDir, getDataDir } from '@/lib/project/paths'
import { isTorEnabled } from '@/lib/git'

/** Deployment/Service name and pod selector label of the shared proxy. */
export const PROXY_APP_NAME = 'yaac-proxy'
/** Secret holding the daemon→proxy bearer secret. */
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
 * Inner (nested / yaac-in-yaac) redirect objects. The daemon projects these
 * into a managed vcluster's host namespace so the vcluster's synced pods are
 * redirected to that session's *inner* proxy at higher precedence than the
 * outer redirect (see plans/yaac-in-yaac-inner-egress.md). The session pod
 * never gets host RBAC — the daemon rebuilds them from these trusted builders.
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
 * every session's egress (see plans/distributed-mapping-pine.md).
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
 * Label the syncer stamps on a vcluster's synced pods (value = the vcluster
 * name). Literal, not imported from vcluster.ts, to avoid a bootstrap↔vcluster
 * import cycle (same reason the registry/vcluster ports are literals above).
 */
export const LABEL_VCLUSTER_MANAGED_BY = 'vcluster.loft.sh/managed-by'
/**
 * Role label + value the inner proxy pod carries so the inner override can
 * exclude it (loop-free): the inner proxy is NOT redirected to itself, so its
 * own upstream dials fall through to the outer redirect → outer proxy → world.
 */
export const LABEL_ROLE = 'yaac.role'
export const ROLE_INNER_PROXY = 'inner-proxy'
/**
 * Nested (inner) proxy only. The inner proxy's chained upstream dial
 * (inner session → inner proxy → OUTER proxy → internet) terminates TLS at
 * the outer proxy, which presents a leaf signed by the OUTER proxy's MITM CA.
 * The stock proxy dials upstream with Node's default trust store, so without
 * the outer CA that dial fails with "self-signed certificate in certificate
 * chain" and the inner session has no internet. The daemon projects the outer
 * CA into the vcluster as this ConfigMap; the inner proxy mounts it and points
 * NODE_EXTRA_CA_CERTS at it (additive trust — the real roots still apply). The
 * inner yaac reads the outer CA from its own session-pod trust mount
 * (pod-spec CA_CERT_PATH).
 */
export const OUTER_CA_CONFIGMAP_NAME = 'yaac-outer-proxy-ca'
/** Mount dir + file for the projected outer CA inside the inner proxy. A
 * dedicated dir (not the session CA mount) so it never collides with the
 * inner proxy's own CA material. */
const OUTER_CA_MOUNT_DIR = '/etc/yaac/outer-ca'
const OUTER_CA_PATH = `${OUTER_CA_MOUNT_DIR}/${CA_CONFIGMAP_KEY}`
/**
 * The cluster's service subnet, pinned in k8s/kind-config.yaml.
 * clusterIpForNamespace hashes the proxy Service's pinned VIP into this
 * compiled value, so a drifted live cluster would fail Service creation
 * ("provided IP is not in the valid range") — `yaac cluster check`
 * warns on drift.
 */
export const CLUSTER_SERVICE_CIDR = '10.96.0.0/16'

/**
 * Deterministic per-namespace ClusterIP for the proxy Service, pinned at
 * Service creation. The relay dials this VIP directly (PROXY_HOST in its
 * env), so it never resolves a DNS name — which is what lets the pod's
 * udp/53 REDIRECT capture everything unconditionally — and because
 * recreation reproduces the identical VIP by construction, a
 * deleted-and-recreated Service can never strand the env-frozen relays
 * of running sessions. Per-namespace, not one fixed IP, because
 * ClusterIPs are cluster-scoped and e2e per-run namespaces coexist with
 * the production namespace on the same cluster.
 *
 * Hashes the namespace across (almost) the whole service /16 — ~65.5k
 * slots, skipping the first 16 addresses (network, apiserver .1, kube-dns
 * .10) and the top 16 (…255.255 broadcast). The wide span is what keeps
 * pin-vs-pin collisions negligible when many Services coexist: a
 * cluster-scoped ClusterIP clash makes the second `kubectl apply` fail
 * loudly ("provided IP is already allocated") — never a misroute, but a
 * hard failure — and the birthday math is unforgiving in a small band
 * (50 coexisting pins → ~99.7% collision in a single /24's ~224 slots,
 * vs ~1.9% across the /16). This matters for the nested-containers plan,
 * where per-session vclusters + per-project registries could stand up
 * dozens of pinned Services at once (see plans/nested-containers-plan.md).
 *
 * Tradeoff vs the old /24 band: this spills past the k8s "static
 * subrange" — the low 256 the dynamic allocator avoids (KEP-3070, GA
 * since 1.26), which is capped at 256 addresses regardless of CIDR size,
 * so there is no race-free way to get more than ~250 slots. A pin in the
 * upper band CAN therefore collide with a *dynamically*-allocated
 * Service. On yaac's dedicated cluster that risk is near-zero (yaac pins
 * every Service it creates, so nothing it controls is dynamically
 * allocated; only kube-system's init-time low statics exist), and a
 * clash still errors loudly rather than misrouting. The nested plan must
 * re-confirm this holds once vcluster's own (yaac-uncontrolled) Services
 * enter the picture.
 *
 * Assumes the compiled /16 CLUSTER_SERVICE_CIDR; `yaac cluster check`
 * warns when the live cluster's service subnet drifts from it.
 */
export function clusterIpForNamespace(namespace: string): string {
  return pinnedClusterIp(namespace)
}

/**
 * Keyed generalization of the VIP pin for the other Services yaac
 * creates (per-project registries, per-session vcluster APIs — see
 * plans/nested-containers-plan.md). Hashes `<namespace>/<serviceName>`
 * across the same /16 band, so all pins share one collision budget (the
 * birthday math in clusterIpForNamespace's docstring covers them
 * jointly). `/` cannot appear in a namespace name, so these keys can
 * never alias the bare-namespace key of the proxy pin.
 *
 * FROZEN, like the namespace pin: these VIPs are baked into running
 * pods' iptables carve-outs (EXTRA_TCP_ACCEPT), pod hostAliases, and
 * node hosts.toml files — re-keying the hash would strand them all.
 */
export function clusterIpForService(namespace: string, serviceName: string): string {
  return pinnedClusterIp(`${namespace}/${serviceName}`)
}

function pinnedClusterIp(key: string): string {
  const [addr, prefix] = CLUSTER_SERVICE_CIDR.split('/')
  const baseInt = addr.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0)
  const total = 2 ** (32 - Number(prefix))
  // Skip the low 16 (network + apiserver .1 + kube-dns .10) and the top
  // 16 (…broadcast); hash the key uniformly across the rest.
  const span = total - 32
  const hash = crypto.createHash('sha256').update(key).digest()
  const ipInt = (baseInt + 16 + (hash.readUInt32BE(0) % span)) >>> 0
  return [(ipInt >>> 24) & 0xff, (ipInt >>> 16) & 0xff, (ipInt >>> 8) & 0xff, ipInt & 0xff].join('.')
}

/**
 * Pod securityContext running the proxy as the daemon's own host uid/gid.
 * The proxy reads/writes hostPath dirs the daemon creates (the CA in
 * /data, the ssh-agent socket dir, and the 0700 credentials dir);
 * matching the creator's uid is what makes those accessible. The image's
 * default `node` uid (1000) only worked on applehv, whose virtiofs
 * ignored ownership — libkrun's enforces it, so a uid mismatch is EACCES.
 *
 * fsGroup makes the emptyDir-backed HOME (see the deployment) group-
 * writable by the proxy process; it applies only to ownership-managed
 * volumes (emptyDir), never to the hostPath mounts, which stay owned by
 * the host uid. Throws if getuid/getgid are unavailable: the daemon's
 * whole hostPath/uid model is POSIX-only, and silently emitting an
 * image-default-uid manifest would crash-loop the proxy on a strict
 * virtiofs host with a confusing EACCES instead of failing here.
 */
export function proxyRunAsSecurityContext(): Record<string, unknown> {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) {
    throw new Error(
      'proxyRunAsSecurityContext: process.getuid/getgid unavailable — '
      + 'the yaac daemon requires a POSIX host',
    )
  }
  return { securityContext: { runAsUser: uid, runAsGroup: gid, fsGroup: gid } }
}

/**
 * Host directory shared between the proxy pod (which runs ssh-agent on a
 * socket here) and session pods (which point SSH_AUTH_SOCK at it).
 * Single-node assumption: hostPath UNIX sockets only cross pods on the
 * same node.
 */
export function sshAgentHostDir(): string {
  return path.join(getDataDir(), 'run', 'ssh-agent')
}

/**
 * Host directory backing the proxy's `/data` (CA key/cert, tor state).
 * Persisting it across pod replacements keeps the MITM CA stable, so
 * session pods' mounted CA stays valid through proxy image upgrades.
 */
export function proxyDataHostDir(): string {
  return path.join(getDataDir(), 'run', 'proxy-data')
}

export async function ensureNamespace(): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: k8sNamespace() },
  })
}

interface RawSecret {
  data?: Record<string, string>
}

/**
 * Ensure the proxy auth Secret exists and return its value. The secret is
 * generated once per cluster and read back on every daemon start —
 * replacing the podman-era trick of recovering it from the proxy
 * container's env on adoption.
 */
export async function ensureProxyAuthSecret(): Promise<string> {
  const existing = await kubectlGetJson<RawSecret>([
    'get', 'secret', PROXY_AUTH_SECRET_NAME, '-n', k8sNamespace(),
  ])
  const encoded = existing?.data?.secret
  if (encoded) return Buffer.from(encoded, 'base64').toString('utf8')

  const secret = crypto.randomBytes(32).toString('hex')
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: PROXY_AUTH_SECRET_NAME, namespace: k8sNamespace() },
    type: 'Opaque',
    data: { secret: Buffer.from(secret).toString('base64') },
  })
  return secret
}

/**
 * Build the proxy Deployment manifest. Exported for unit tests; applied
 * by `ensureProxyResources`.
 *
 * Exposure: ClusterIP Service only — no hostNetwork, no hostPort, no
 * NodePort. The proxy listens inside its pod's network namespace; the
 * daemon reaches it through a loopback `kubectl port-forward`.
 */
export function buildProxyDeploymentManifest(
  imageRef: string,
  opts: { nested?: boolean } = {},
): Record<string, unknown> {
  // Nested (inner) proxy: stamp the role so the inner override CNP can
  // exclude it (loop-free) and the projection can discover it.
  const podLabels = opts.nested
    ? { app: PROXY_APP_NAME, [LABEL_ROLE]: ROLE_INNER_PROXY }
    : { app: PROXY_APP_NAME }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: PROXY_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      replicas: 1,
      // Recreate, not RollingUpdate: two proxy pods would race over the
      // shared hostPath ssh-agent socket during the overlap window.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { app: PROXY_APP_NAME } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // The proxy watches pods (source-IP → session) via the in-cluster
          // API, so it needs its SA token mounted — read-only pods access
          // granted by buildProxyRoleManifest.
          serviceAccountName: PROXY_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Nested (inner) proxy: resolve upstream hostnames via its OWN DNS
          // stub (loopback), not the vcluster CoreDNS. The inner proxy carries
          // `managed-by`, so the outer yaac's fallback redirect catches its
          // egress and default-denies everything but world:443/80 (→ outer
          // proxy) + 53→itself — so a query to the vcluster CoreDNS is dropped
          // (getaddrinfo EAI_AGAIN). Its stub sinkholes every name to the dummy
          // IP; the proxy then dials that, the fallback redirects it to the
          // outer proxy, and the outer proxy resolves+dials the real upstream
          // (SNI-routed). dnsPolicy:None + an explicit nameserver survives
          // vcluster sync (the N3 spike confirmed this). Top-level proxy keeps
          // the cluster default — it reaches the world directly and needs real
          // resolution via cluster CoreDNS.
          ...(opts.nested
            ? { dnsPolicy: 'None', dnsConfig: { nameservers: ['127.0.0.1'] } }
            : {}),
          ...proxyRunAsSecurityContext(),
          containers: [
            {
              name: 'proxy',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              // NET_BIND_SERVICE lets the non-root proxy bind udp/53 for the
              // DNS stub, keeping the Service's port==targetPort invariant
              // (no remap, so policy and Service agree on the port).
              securityContext: { capabilities: { add: ['NET_BIND_SERVICE'] } },
              ports: [
                { containerPort: PROXY_PORT },
                { containerPort: TRANSPARENT_HTTPS_PORT },
                { containerPort: TRANSPARENT_HTTP_PORT },
                { containerPort: TRANSPARENT_TUNNEL_PORT },
                { containerPort: DNS_STUB_PORT, protocol: 'UDP' },
              ],
              env: [
                { name: 'API_PORT', value: String(PROXY_PORT) },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
                { name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) },
                {
                  name: 'PROXY_AUTH_SECRET',
                  valueFrom: {
                    secretKeyRef: { name: PROXY_AUTH_SECRET_NAME, key: 'secret' },
                  },
                },
                // The proxy runs as the daemon's host uid (runAsUser
                // below), which need not own the image's /home/node — so
                // point HOME at a dedicated emptyDir (writable via fsGroup)
                // rather than the CA-bearing /data, keeping ssh material
                // (only public known_hosts) out of the persisted secret
                // dir. ssh-add and the known_hosts writer resolve ~ here.
                { name: 'HOME', value: '/home/proxy' },
                ...(isTorEnabled() ? [{ name: 'USE_TOR', value: '1' }] : []),
                // Nested (inner) proxy: trust the OUTER proxy's MITM CA so the
                // chained upstream dial (→ outer proxy) validates. Additive —
                // Node still consults its bundled roots. See OUTER_CA_*.
                ...(opts.nested
                  ? [{ name: 'NODE_EXTRA_CA_CERTS', value: OUTER_CA_PATH }]
                  : []),
              ],
              readinessProbe: {
                httpGet: { path: '/healthz', port: PROXY_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              volumeMounts: [
                { name: 'credentials', mountPath: '/yaac-credentials' },
                { name: 'ssh-agent', mountPath: '/ssh-agent' },
                { name: 'proxy-data', mountPath: '/data' },
                { name: 'home', mountPath: '/home/proxy' },
                ...(opts.nested
                  ? [{ name: 'outer-ca', mountPath: OUTER_CA_MOUNT_DIR, readOnly: true }]
                  : []),
              ],
            },
          ],
          volumes: [
            {
              name: 'credentials',
              hostPath: { path: credentialsDir(), type: 'DirectoryOrCreate' },
            },
            {
              name: 'ssh-agent',
              hostPath: { path: sshAgentHostDir(), type: 'DirectoryOrCreate' },
            },
            {
              name: 'proxy-data',
              hostPath: { path: proxyDataHostDir(), type: 'DirectoryOrCreate' },
            },
            // Writable HOME for the proxy's ssh-add/known_hosts. emptyDir
            // (not hostPath) so fsGroup can make it group-writable by the
            // non-root proxy uid, and so nothing the proxy writes under
            // HOME persists onto the host.
            { name: 'home', emptyDir: {} },
            // Nested (inner) proxy: the outer CA, projected by the daemon into
            // the vcluster as a ConfigMap (buildOuterProxyCaConfigMapManifest).
            ...(opts.nested
              ? [{ name: 'outer-ca', configMap: { name: OUTER_CA_CONFIGMAP_NAME } }]
              : []),
          ],
        },
      },
    },
  }
}

/**
 * ConfigMap carrying the OUTER proxy's CA, applied by a nested (inner) yaac
 * into its vcluster so the inner proxy can trust the outer proxy's MITM leaf
 * on its chained upstream hop (see OUTER_CA_CONFIGMAP_NAME). vcluster syncs it
 * to the host because the inner proxy pod mounts it. Pure builder — the caller
 * reads the outer CA (from CA_CERT_PATH, its own trust mount) and applies.
 */
export function buildOuterProxyCaConfigMapManifest(caPem: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: OUTER_CA_CONFIGMAP_NAME, namespace: k8sNamespace() },
    data: { [CA_CONFIGMAP_KEY]: caPem },
  }
}

/** Blanket world-egress deny (CiliumNetworkPolicy) — see the builder. */
export const EGRESS_WORLD_DENY_NAME = 'yaac-egress-world-deny'

/**
 * Blanket CiliumNetworkPolicy denying egress to the `world` entity
 * (everything outside the cluster) for every pod in the install
 * namespace except the proxy — the only pod that legitimately reaches
 * the internet (it dials allowlisted upstreams on sessions' behalf).
 *
 * `app NotIn [yaac-proxy]` denies world for everything except the proxy;
 * NotIn also matches pods with no `app` label, so it catches registries,
 * mocks, and anything added later. The exemption label can only be set by
 * the trusted daemon on its own pods, so it is not a forge vector.
 *
 * Session pods (`yaac.session-id`) are explicitly EXCLUDED here: their
 * egress is governed by the redirect CNP (buildSessionEgressRedirectCnpManifest),
 * which is itself default-deny and only permits 443/80→Envoy, the SSH
 * sentinel, and DNS. A world-deny over them would beat the redirect's
 * world:443/80 allow (Cilium deny > allow) and block all egress.
 *
 * Namespace-scoped, not cluster-wide on purpose: a cluster-wide deny
 * would also hit kube-system CoreDNS (whose upstream forwarding the proxy
 * needs to resolve external hosts) and the Cilium/system pods. vcluster
 * synced pods live in their OWN per-session namespaces, where the
 * unforgeable per-vcluster fallback redirect (default-deny + redirect to
 * the outer proxy, buildVclusterFallbackRedirectCnpManifest) is their
 * containment floor, so they are covered there rather than here.
 *
 * Why a Cilium *deny* rather than a k8s NetworkPolicy: deny rules take
 * precedence over allows and cannot be widened by union, so a tenant
 * allow-all NetworkPolicy cannot punch through it. `world` excludes
 * in-cluster pods, the service CIDR, the host, and the apiserver, so
 * every legitimate intra-cluster flow (relay->proxy VIP, vcluster API)
 * is untouched, and image pulls run on the node (not in pods) so they
 * are unaffected.
 */
export function buildEgressWorldDenyCiliumPolicyManifest(): Record<string, unknown> {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: EGRESS_WORLD_DENY_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      endpointSelector: {
        matchExpressions: [
          { key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME] },
          { key: LABEL_SESSION_ID, operator: 'DoesNotExist' },
        ],
      },
      egressDeny: [{ toEntities: ['world'] }],
    },
  }
}

/** Envoy listener names referenced by both the CEC and the redirect CNP. */
const LISTENER_HTTPS = 'yaac-egress-https'
const LISTENER_HTTP = 'yaac-egress-http'
const LISTENER_TUNNEL = 'yaac-egress-tunnel'

/**
 * The Envoy cluster name Cilium populates (via EDS) with a backend Service's
 * endpoints for one of its ports. Convention is `<namespace>/<service>:<port>`
 * (the port is the Service port *number*) — it must match a `backendServices`
 * entry in the same CEC. See `buildEgressRedirectCecManifest`.
 */
function edsClusterName(namespace: string, service: string, port: number): string {
  return `${namespace}/${service}:${port}`
}

/**
 * One Envoy listener + its upstream cluster: a bare tcp_proxy that forwards
 * everything to the proxy on `upstreamPort`, wrapping the upstream connection
 * in PROXY-protocol-v2 so the proxy sees the real client (source) IP and the
 * original destination.
 *
 * The cluster is **EDS** (`type: EDS`), not a static ClusterIP endpoint:
 * Cilium's node-local Envoy makes upstream connections from the host netns,
 * and those do **not** traverse kube-proxy's ClusterIP DNAT (socket-LB is off
 * here, `KubeProxyReplacement: False`), so a static ClusterIP target dead-ends
 * on `cx_connect_fail`. EDS makes Cilium sync the proxy Service's real backend
 * pod endpoints into the cluster (see the CEC's `backendServices`), so Envoy
 * dials the proxy pod IP directly. Cilium injects its own bpf_metadata listener
 * filter (identity resolution); the CEC annotation turns its transparent-source
 * binding off so the connect to the fixed proxy succeeds.
 */
function redirectListenerAndCluster(
  listenerName: string,
  clusterName: string,
): Record<string, unknown>[] {
  return [
    {
      '@type': 'type.googleapis.com/envoy.config.listener.v3.Listener',
      name: listenerName,
      filterChains: [{
        filters: [{
          name: 'envoy.filters.network.tcp_proxy',
          typedConfig: {
            '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
            statPrefix: listenerName,
            cluster: clusterName,
          },
        }],
      }],
    },
    {
      '@type': 'type.googleapis.com/envoy.config.cluster.v3.Cluster',
      name: clusterName,
      connectTimeout: '5s',
      type: 'EDS',
      transportSocket: {
        name: 'envoy.transport_sockets.upstream_proxy_protocol',
        typedConfig: {
          '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.proxy_protocol.v3.ProxyProtocolUpstreamTransport',
          config: { version: 'V2' },
          transportSocket: {
            name: 'envoy.transport_sockets.raw_buffer',
            typedConfig: { '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.raw_buffer.v3.RawBuffer' },
          },
        },
      },
    },
  ]
}

/**
 * CiliumEnvoyConfig programming the node-local Envoy with three listeners
 * (HTTPS/HTTP/tunnel) that forward redirected session egress to the proxy's
 * matching transparent listener. Replaces the per-pod relay: identity is the
 * source pod IP carried in the upstream PROXY-protocol header (the proxy maps
 * it to a session — see k8s/proxy), not an HMAC token.
 *
 * The `cec.cilium.io/use-original-source-address: "false"` annotation is
 * load-bearing: without it Cilium binds the upstream socket to the client pod
 * IP, and forwarding to a fixed proxy (not the original dst) then dead-ends on
 * the return path. Requires `envoyConfig.enabled=true` on the Cilium install
 * (scripts/setup-kind-cluster.sh).
 *
 * `backendServices` is what makes the EDS clusters resolve: Cilium syncs the
 * proxy Service's backend endpoints (for the listed port numbers) into the
 * matching `<ns>/<service>:<port>` clusters, so Envoy dials the proxy pod IP
 * directly rather than a ClusterIP it cannot route to from the host netns.
 *
 * `cecNamespace` is where the CEC lives, or `null` to emit a cluster-scoped
 * `CiliumClusterwideEnvoyConfig` (CCEC) instead — used by the shared vcluster
 * fallback so a per-vcluster CNP can reference it cross-namespace (a CNP's
 * `listener.envoyConfig` ref resolves a namespaced CEC only in the CNP's own
 * namespace, but a CCEC is cluster-scoped). `proxyNamespace`/`proxyService` name
 * the upstream proxy Service its EDS clusters resolve (`backendServices` carries
 * a namespace, so the shared fallback CCEC targets the outer proxy regardless of
 * which vcluster namespace the redirected pod lives in).
 */
function buildRedirectCec(
  cecName: string,
  cecNamespace: string | null,
  proxyNamespace: string,
  proxyService: string,
): Record<string, unknown> {
  const cluster = (port: number): string => edsClusterName(proxyNamespace, proxyService, port)
  const clusterScoped = cecNamespace === null
  return {
    apiVersion: 'cilium.io/v2',
    kind: clusterScoped ? 'CiliumClusterwideEnvoyConfig' : 'CiliumEnvoyConfig',
    metadata: {
      name: cecName,
      ...(clusterScoped ? {} : { namespace: cecNamespace }),
      labels: { app: PROXY_APP_NAME },
      annotations: { 'cec.cilium.io/use-original-source-address': 'false' },
    },
    spec: {
      backendServices: [{
        name: proxyService,
        namespace: proxyNamespace,
        number: [
          String(TRANSPARENT_HTTPS_PORT),
          String(TRANSPARENT_HTTP_PORT),
          String(TRANSPARENT_TUNNEL_PORT),
        ],
      }],
      resources: [
        ...redirectListenerAndCluster(LISTENER_HTTPS, cluster(TRANSPARENT_HTTPS_PORT)),
        ...redirectListenerAndCluster(LISTENER_HTTP, cluster(TRANSPARENT_HTTP_PORT)),
        ...redirectListenerAndCluster(LISTENER_TUNNEL, cluster(TRANSPARENT_TUNNEL_PORT)),
      ],
    },
  }
}

export function buildEgressRedirectCecManifest(): Record<string, unknown> {
  return buildRedirectCec(EGRESS_REDIRECT_CEC_NAME, k8sNamespace(), k8sNamespace(), PROXY_APP_NAME)
}

/**
 * A `toPorts.listener` reference to a listener in a CEC. Every yaac's
 * session-egress redirect carries the same normal `priority`; the inner one
 * is identical (transparent), and the outer vcluster fallback uses a lower
 * precedence so the inner wins — see SESSION_REDIRECT_PRIORITY.
 */
function listenerRef(
  cecName: string,
  name: string,
  priority?: number,
  kind: 'CiliumEnvoyConfig' | 'CiliumClusterwideEnvoyConfig' = 'CiliumEnvoyConfig',
): Record<string, unknown> {
  const ref: Record<string, unknown> = { envoyConfig: { kind, name: cecName }, name }
  if (priority !== undefined) ref.priority = priority
  return ref
}

/** Reference to a listener in the (outer) egress-redirect CEC, at normal priority. */
function cecListenerRef(name: string): Record<string, unknown> {
  return listenerRef(EGRESS_REDIRECT_CEC_NAME, name, SESSION_REDIRECT_PRIORITY)
}

/**
 * CiliumNetworkPolicy that L7-redirects session-pod egress into the CEC
 * listeners. Selecting any pod with the session-id label makes Cilium
 * default-deny that pod's egress except: 443/80 to any external host (→ the
 * HTTPS/HTTP listeners), the SSH sentinel on TUNNEL_INGRESS_PORT (→ the tunnel
 * listener), and udp/53 to the proxy's DNS stub. This replaces both the old
 * k8s session NetworkPolicy and the per-pod iptables default-deny.
 */
export function buildSessionEgressRedirectCnpManifest(): Record<string, unknown> {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: SESSION_EGRESS_REDIRECT_CNP_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      endpointSelector: { matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }] },
      egress: [
        {
          toEntities: ['world'],
          toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }], listener: cecListenerRef(LISTENER_HTTPS) }],
        },
        {
          toEntities: ['world'],
          toPorts: [{ ports: [{ port: '80', protocol: 'TCP' }], listener: cecListenerRef(LISTENER_HTTP) }],
        },
        {
          toCIDRSet: [{ cidr: `${SSH_TUNNEL_SENTINEL}/32` }],
          toPorts: [{ ports: [{ port: String(TUNNEL_INGRESS_PORT), protocol: 'TCP' }], listener: cecListenerRef(LISTENER_TUNNEL) }],
        },
        {
          toEndpoints: [{ matchLabels: { app: PROXY_APP_NAME } }],
          toPorts: [{ ports: [{ port: String(DNS_STUB_PORT), protocol: 'UDP' }] }],
        },
        // In-cluster carve-outs for vcluster sessions: the per-project push
        // registry (5000) and the per-session vcluster API (8443). Plain
        // L3/L4 (no listener) — direct in-cluster flows, not MITM'd; the
        // receiving pods carry their own ingress policies. Ports mirror
        // PROJECT_REGISTRY_PORT / VCLUSTER_API_PORT (not imported, to avoid a
        // bootstrap↔vcluster import cycle).
        {
          toEndpoints: [{}],
          toPorts: [{ ports: [
            { port: '5000', protocol: 'TCP' },
            { port: '8443', protocol: 'TCP' },
          ] }],
        },
      ],
    },
  }
}

/**
 * CiliumNetworkPolicy locking the proxy's INGRESS.
 *
 * Key Cilium fact (verified empirically, not the original plan's guess): when
 * the node-local Envoy forwards redirected egress to the proxy, Cilium does
 * NOT relabel the connection as `host`/`ingress`. With the CEC's
 * `use-original-source-address: false` the *source IP* becomes `cilium_host`,
 * but Cilium PRESERVES the original endpoint's **security identity** through
 * the proxy — so at the proxy the redirected traffic carries the *session
 * pod's* identity (`yaac.session-id` label), indistinguishable at L3/L4 from a
 * direct dial. Hence the transparent ports must be opened to the session-pod
 * identity, not to `host`.
 *
 * The forgery lock therefore lives on the **egress** side, not here: a session
 * pod's egress policy (buildSessionEgressRedirectCnpManifest) permits only
 * 443/80→world (redirected via the CEC listener), the tunnel sentinel, DNS,
 * and the in-cluster carve-outs — it has NO rule to the proxy's transparent
 * ports, so a direct dial is dropped at the source. And because Cilium verifies
 * pod source IPs, the only way to reach a transparent port is the redirect,
 * which stamps the *real* (unspoofable) pod IP into the PROXY-protocol header.
 * The e2e forgery test (a session pod dialing a transparent port directly must
 * fail) is the standing guard.
 *
 * PROXY_PORT (the control API) stays host-only — the daemon registers sessions
 * over it and the kubelet readiness probe hits it; session pods must not.
 */
export function buildProxyIngressCnpManifest(): Record<string, unknown> {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: PROXY_INGRESS_CNP_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      endpointSelector: { matchLabels: { app: PROXY_APP_NAME } },
      ingress: [
        {
          // Control API: the host daemon (session registration) + kubelet probe.
          fromEntities: ['host'],
          toPorts: [{ ports: [{ port: String(PROXY_PORT), protocol: 'TCP' }] }],
        },
        {
          // Redirected session egress (transparent listeners) + DNS stub. The
          // redirected traffic arrives with the session pod's identity (see the
          // docstring); a direct dial is blocked at the pod's own egress.
          fromEndpoints: [{ matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }] }],
          toPorts: [{ ports: [
            { port: String(TRANSPARENT_HTTPS_PORT), protocol: 'TCP' },
            { port: String(TRANSPARENT_HTTP_PORT), protocol: 'TCP' },
            { port: String(TRANSPARENT_TUNNEL_PORT), protocol: 'TCP' },
            { port: String(DNS_STUB_PORT), protocol: 'UDP' },
          ] }],
        },
        {
          // yaac-in-yaac: a vcluster's synced pods chain to THIS (outer) proxy
          // via the per-vcluster fallback redirect — the inner proxy's upstream
          // dials, and any synced pod's egress before an inner yaac opts in.
          // They arrive (identity preserved) carrying the syncer-stamped
          // `managed-by` label from another namespace, so admit the transparent
          // ports cross-namespace (`managed-by` Exists + any pod namespace). No
          // DNS: the inner proxy sinkholes via its own stub and synced session
          // pods resolve via the inner proxy, so neither dials the outer proxy
          // for 53. The forgery lock still holds on egress (a vcluster pod's
          // default-deny has no route to a transparent port except the
          // redirect), and the source IP is attributed to the OWNING outer
          // session, so the outer allowlist is enforced — fail-closed if the IP
          // is unknown.
          fromEndpoints: [{ matchExpressions: [
            { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'Exists' },
            { key: 'k8s:io.kubernetes.pod.namespace', operator: 'Exists' },
          ] }],
          toPorts: [{ ports: [
            { port: String(TRANSPARENT_HTTPS_PORT), protocol: 'TCP' },
            { port: String(TRANSPARENT_HTTP_PORT), protocol: 'TCP' },
            { port: String(TRANSPARENT_TUNNEL_PORT), protocol: 'TCP' },
          ] }],
        },
      ],
    },
  }
}

/**
 * Inner egress-redirect CEC the daemon projects into a vcluster's host
 * namespace. Same three listeners as the outer CEC, but EDS-backed by the
 * **inner** proxy's host-synced Service (`innerProxyService` in `vcNamespace` —
 * its name is vcluster-translated, so the daemon discovers and passes it). The
 * inner override CNP references these listeners at a winning priority.
 */
export function buildInnerEgressRedirectCecManifest(
  vcNamespace: string,
  innerProxyService: string,
): Record<string, unknown> {
  return buildRedirectCec(INNER_EGRESS_REDIRECT_CEC_NAME, vcNamespace, vcNamespace, innerProxyService)
}

/**
 * Inner session-egress redirect CNP (the override). Selects a vcluster's synced
 * pods (`managed-by=<vcName>`) EXCEPT the inner proxy (`yaac.role != inner-proxy`)
 * and redirects their 443/80/SSH egress into the inner CEC at the normal priority
 * (SESSION_REDIRECT_PRIORITY), which beats the fallback (a lower precedence) — so
 * inner-session world traffic flows to the INNER proxy while the inner proxy's own
 * egress stays on the fallback → outer proxy (loop-free).
 *
 * This is a ROUTING override, NOT a containment boundary. The unforgeable fallback
 * (buildVclusterFallbackRedirectCnpManifest) already default-denies every synced
 * pod's raw world and supplies intracluster + DNS (the inner proxy's DNS stub is a
 * `managed-by` sibling there), so this policy only needs the world redirects. The
 * `yaac.role` exclusion is tenant-forgeable, but forging it is non-escalating: a
 * session that forges `inner-proxy` merely drops to the fallback → OUTER proxy
 * (still allowlisted), never to raw world.
 */
export function buildInnerSessionEgressRedirectCnpManifest(
  vcNamespace: string,
  vcName: string,
): Record<string, unknown> {
  const ref = (listener: string): Record<string, unknown> =>
    listenerRef(INNER_EGRESS_REDIRECT_CEC_NAME, listener, SESSION_REDIRECT_PRIORITY)
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
      namespace: vcNamespace,
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      endpointSelector: { matchExpressions: [
        { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [vcName] },
        { key: LABEL_ROLE, operator: 'NotIn', values: [ROLE_INNER_PROXY] },
      ] },
      egress: [
        {
          toEntities: ['world'],
          toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }], listener: ref(LISTENER_HTTPS) }],
        },
        {
          toEntities: ['world'],
          toPorts: [{ ports: [{ port: '80', protocol: 'TCP' }], listener: ref(LISTENER_HTTP) }],
        },
        {
          toCIDRSet: [{ cidr: `${SSH_TUNNEL_SENTINEL}/32` }],
          toPorts: [{ ports: [{ port: String(TUNNEL_INGRESS_PORT), protocol: 'TCP' }], listener: ref(LISTENER_TUNNEL) }],
        },
      ],
    },
  }
}

/**
 * Inner proxy-ingress CNP. Locks the inner proxy's transparent ports to the
 * redirected synced-pod identity (`managed-by=<vcName>`) and its control API to
 * the host — the same trust model as the outer proxy-ingress (the redirect
 * preserves the source pod's identity; a direct dial is blocked at egress).
 */
export function buildInnerProxyIngressCnpManifest(
  vcNamespace: string,
  vcName: string,
): Record<string, unknown> {
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: INNER_PROXY_INGRESS_CNP_NAME,
      namespace: vcNamespace,
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      endpointSelector: { matchLabels: { [LABEL_ROLE]: ROLE_INNER_PROXY } },
      ingress: [
        {
          fromEntities: ['host'],
          toPorts: [{ ports: [{ port: String(PROXY_PORT), protocol: 'TCP' }] }],
        },
        {
          fromEndpoints: [{ matchExpressions: [
            { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [vcName] },
          ] }],
          toPorts: [{ ports: [
            { port: String(TRANSPARENT_HTTPS_PORT), protocol: 'TCP' },
            { port: String(TRANSPARENT_HTTP_PORT), protocol: 'TCP' },
            { port: String(TRANSPARENT_TUNNEL_PORT), protocol: 'TCP' },
            { port: String(DNS_STUB_PORT), protocol: 'UDP' },
          ] }],
        },
      ],
    },
  }
}

/**
 * Cluster-scoped name of this install's shared fallback CCEC. A CCEC name is
 * global, so it's suffixed with the install namespace: the real `yaac` install
 * and any ephemeral e2e `yaac-test-<run-id>` install can coexist on one cluster,
 * each with its own singleton CCEC EDS-backed by its own proxy.
 */
export function vclusterFallbackCcecName(namespace: string): string {
  return `${VCLUSTER_FALLBACK_REDIRECT_NAME}-${namespace}`
}

/**
 * The outer yaac's fallback redirect for every vcluster's synced pods, as a
 * SINGLE shared cluster-scoped CCEC (EDS-backed by the OUTER proxy). One per
 * install, created once at bootstrap — NOT per vcluster — so vcluster churn
 * never adds/removes Envoy listeners. Each vcluster's fallback CNP references
 * this CCEC cross-namespace by `kind: CiliumClusterwideEnvoyConfig` (a CNP's
 * `listener.envoyConfig` ref carries no namespace, but a CCEC needs none). The
 * CCEC is cluster-scoped, so it does NOT cascade on namespace deletion — it is
 * torn down explicitly (e2e global-setup cleanup; install teardown).
 */
export function buildVclusterFallbackRedirectCcecManifest(): Record<string, unknown> {
  const manifest = buildRedirectCec(
    vclusterFallbackCcecName(k8sNamespace()), null, k8sNamespace(), PROXY_APP_NAME,
  )
  // Cluster-scoped: tag with the owning install namespace so teardown can find it.
  const metadata = manifest.metadata as Record<string, unknown>
  metadata.labels = { ...(metadata.labels as Record<string, string>), 'yaac.install-namespace': k8sNamespace() }
  return manifest
}

/**
 * The vcluster's synced-pod egress floor — the single unforgeable containment
 * policy for everything that runs inside a per-session vcluster. Selects ALL
 * synced pods by the syncer-stamped `managed-by=<vcName>` label (a tenant inside
 * the vcluster cannot suppress or forge it), makes their egress default-deny, and
 * permits exactly:
 *
 *   - 443/80/SSH → the OUTER proxy, redirected via the shared fallback CCEC
 *     (cluster-scoped, referenced by kind) at a deliberately LOW precedence
 *     (VCLUSTER_FALLBACK_PRIORITY ≫
 *     SESSION_REDIRECT_PRIORITY) so an inner yaac's normal-priority override
 *     (buildInnerSessionEgressRedirectCnpManifest) wins for its session pods,
 *     while the inner proxy itself (excluded from that override) stays on this
 *     fallback → outer proxy (loop-free chaining).
 *   - intracluster: the vcluster API (control-plane pod on 8443) and sibling
 *     synced pods on any port — inner services, the vcluster CoreDNS, and an
 *     inner proxy's DNS stub, all `managed-by` so matched unforgeably.
 *
 * Everything else (raw world, the host, the host apiserver, other namespaces) is
 * dropped by the default-deny. This is the SOLE guarantee that no synced pod ever
 * reaches raw world — it replaces the former blanket world-deny CNP (which used
 * forgeable exclusions and, being an egressDeny, beat the redirect's allow) and
 * the k8s synced-pods NetworkPolicy (whose intracluster allows are folded in
 * here). A STATIC per-vcluster policy applied at vcluster-creation time BEFORE
 * the chart (so the default-deny is in force before the first synced pod exists)
 * and torn down with the namespace; nothing deletes it in between, so it is not
 * re-asserted per tick (a builder change reaches a running vcluster on recreate).
 */
export function buildVclusterFallbackRedirectCnpManifest(
  vcNamespace: string,
  vcName: string,
): Record<string, unknown> {
  const ref = (listener: string): Record<string, unknown> =>
    listenerRef(
      vclusterFallbackCcecName(k8sNamespace()), listener, VCLUSTER_FALLBACK_PRIORITY,
      'CiliumClusterwideEnvoyConfig',
    )
  return {
    apiVersion: 'cilium.io/v2',
    kind: 'CiliumNetworkPolicy',
    metadata: {
      name: VCLUSTER_FALLBACK_REDIRECT_NAME,
      namespace: vcNamespace,
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      endpointSelector: { matchExpressions: [
        { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [vcName] },
      ] },
      egress: [
        {
          toEntities: ['world'],
          toPorts: [{ ports: [{ port: '443', protocol: 'TCP' }], listener: ref(LISTENER_HTTPS) }],
        },
        {
          toEntities: ['world'],
          toPorts: [{ ports: [{ port: '80', protocol: 'TCP' }], listener: ref(LISTENER_HTTP) }],
        },
        {
          toCIDRSet: [{ cidr: `${SSH_TUNNEL_SENTINEL}/32` }],
          toPorts: [{ ports: [{ port: String(TUNNEL_INGRESS_PORT), protocol: 'TCP' }], listener: ref(LISTENER_TUNNEL) }],
        },
        {
          // Intracluster: the vcluster API (control-plane pod on 8443) — synced
          // pods reach it via the virtual kubernetes.default → host Service DNAT.
          // 8443 mirrors VCLUSTER_API_PORT (literal to avoid a bootstrap↔vcluster
          // import cycle, same as the carve-outs in the outer session-egress CNP).
          toEndpoints: [{ matchLabels: { app: 'vcluster', release: vcName } }],
          toPorts: [{ ports: [{ port: '8443', protocol: 'TCP' }] }],
        },
        {
          // Sibling synced pods, any port: inner services, the vcluster CoreDNS,
          // and an inner proxy's DNS stub — all carry the unforgeable managed-by.
          toEndpoints: [{ matchExpressions: [
            { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'In', values: [vcName] },
          ] }],
        },
      ],
    },
  }
}

/** ServiceAccount the proxy runs as so it can watch pods (source-IP→session). */
export function buildProxyServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
  }
}

/** Read-only Role: the proxy lists/watches pods to resolve source IP→session. */
export function buildProxyRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }],
  }
}

export function buildProxyRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: PROXY_SA_NAME, namespace: k8sNamespace(), labels: { app: PROXY_APP_NAME } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: PROXY_SA_NAME },
    subjects: [{ kind: 'ServiceAccount', name: PROXY_SA_NAME, namespace: k8sNamespace() }],
  }
}

export function buildProxyServiceManifest(
  opts: { nested?: boolean } = {},
): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: PROXY_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      type: 'ClusterIP',
      // Pinned, not allocator-assigned: session pods dial this VIP from env
      // (no DNS), and the pin makes it reproducible across Service recreation
      // — see clusterIpForNamespace. NESTED (inner) proxy: do NOT pin — the
      // host-CIDR pin could collide on the host when vcluster syncs the
      // Service, and the inner redirect uses EDS (endpoints, not the VIP);
      // the inner yaac discovers the allocated ClusterIP for its DNS stub.
      ...(opts.nested ? {} : { clusterIP: clusterIpForNamespace(k8sNamespace()) }),
      selector: { app: PROXY_APP_NAME },
      // port == targetPort throughout: the NetworkPolicy and the in-pod
      // egress filter list the post-translation (transport) port, so a
      // remap would make policy and Service silently diverge.
      ports: [
        { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
        { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
        { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
        { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
        { name: 'dns', port: DNS_STUB_PORT, targetPort: DNS_STUB_PORT, protocol: 'UDP' },
      ],
    },
  }
}

/**
 * Apply the proxy Deployment + Service and wait for the rollout. `kubectl
 * apply` is the drift reconciler: when the proxy image hash changes, the
 * Deployment's pod template changes and kubernetes replaces the pod —
 * the declarative successor to the podman-era hash-in-the-container-name
 * scheme plus manual stale-proxy GC.
 */
/**
 * The live ClusterIP of the proxy Service. For the nested (inner) proxy it's
 * vcluster-allocated (unpinned), so the inner yaac queries it rather than
 * computing clusterIpForNamespace — to use as the inner session pods' DNS
 * nameserver (a vcluster ClusterIP they can reach; the spike confirmed synced
 * pods reach vcluster ClusterIPs and that an explicit dnsConfig survives sync).
 */
export async function proxyServiceClusterIp(): Promise<string> {
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', PROXY_APP_NAME, '-n', k8sNamespace(),
  ])
  const ip = svc?.spec?.clusterIP
  if (!ip) throw new Error('proxy Service has no ClusterIP yet')
  return ip
}

export async function ensureProxyResources(
  imageRef: string,
  opts: { nested?: boolean } = {},
): Promise<void> {
  // Pre-create the credentials dir with tight permissions before any pod
  // mounts it — DirectoryOrCreate would make it root-owned 0755.
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(sshAgentHostDir(), { recursive: true })
  await fs.mkdir(proxyDataHostDir(), { recursive: true })

  // Nested (inner) yaac: its vcluster has no Cilium, so install the CEC/CNP
  // CRDs (permissive) before the CEC/CNP applies below would otherwise fail
  // with "no matches for kind". The inner yaac owns its vcluster — the host
  // never reaches in to register them.
  if (opts.nested) {
    await ensureCiliumCrds()
    // Project the OUTER proxy's CA into the vcluster so the inner proxy's
    // chained upstream dial (inner proxy → outer proxy) trusts the outer MITM
    // leaf — without it every inner-session HTTPS request fails closed with
    // "self-signed certificate in certificate chain". The inner yaac reads the
    // outer CA from its own session-pod trust mount (it already trusts it to
    // reach its own upstream). Applied before the Deployment so the mount
    // resolves on first schedule.
    const outerCaPem = await fs.readFile(CA_CERT_PATH, 'utf8')
    await kubectlApply(buildOuterProxyCaConfigMapManifest(outerCaPem))
  }

  // One-time migration to the pinned VIP: spec.clusterIP is immutable, so
  // on a cluster whose Service predates the pin (or drifted) the apply
  // would fail with "field is immutable" — delete and let the apply below
  // recreate it at the pinned address. Pre-migration sessions are safe
  // across the swap: their relays still hold the proxy's DNS name and
  // Node re-resolves it on every connection. Skipped when nested: the inner
  // proxy Service is unpinned (vcluster-allocated).
  if (!opts.nested) {
    const live = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
      'get', 'service', PROXY_APP_NAME, '-n', k8sNamespace(),
    ])
    if (live && live.spec?.clusterIP !== clusterIpForNamespace(k8sNamespace())) {
      await kubectlWithRetry([
        'delete', 'service', PROXY_APP_NAME, '-n', k8sNamespace(), '--ignore-not-found',
      ])
    }
  }

  // SA + RBAC before the Deployment, which references the SA so the proxy
  // can watch pods (source-IP → session).
  await kubectlApply(buildProxyServiceAccountManifest())
  await kubectlApply(buildProxyRoleManifest())
  await kubectlApply(buildProxyRoleBindingManifest())
  await kubectlApply(buildProxyDeploymentManifest(imageRef, opts))
  await kubectlApply(buildProxyServiceManifest(opts))
  // The egress lockdown, applied with the proxy so it exists before any
  // session pod can be scheduled (sessions require ensureRunning()). CEC
  // before the CNP that references its listeners.
  await kubectlApply(buildEgressRedirectCecManifest())
  await kubectlApply(buildSessionEgressRedirectCnpManifest())
  // The shared, cluster-scoped fallback redirect for vcluster synced pods.
  // Applied once here (not per-vcluster) so each vcluster's fallback CNP can
  // reference it by kind without adding/removing Envoy listeners on create —
  // the churn that otherwise wedges every session's egress. HOST-ONLY: a nested
  // yaac creates no vcluster sessions (vcluster-in-vcluster is rejected) so it
  // never references this, and its vcluster only has the permissive CEC/CNP CRDs
  // (ensureCiliumCrds, above) — applying a CiliumClusterwideEnvoyConfig there
  // would fail "no matches for kind". The outer daemon owns the host-side
  // redirect for every vcluster's synced pods, including a nested yaac's.
  if (!opts.nested) {
    await kubectlApply(buildVclusterFallbackRedirectCcecManifest())
  }
  // Lock the proxy's transparent ports to the node Envoy (forgery guard).
  await kubectlApply(buildProxyIngressCnpManifest())
  // Blanket world-egress deny over non-session pods — the authoritative
  // backstop a vcluster tenant cannot widen (see builder).
  await kubectlApply(buildEgressWorldDenyCiliumPolicyManifest())
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${PROXY_APP_NAME}`,
    '-n', k8sNamespace(),
    '--timeout=180s',
  ], { timeout: 190_000, maxAttempts: 2 })
}

interface RawConfigMap {
  data?: Record<string, string>
}

/**
 * Upsert the proxy-CA ConfigMap that every session pod mounts. Carries two
 * keys: the bare proxy CA (additive trust — SSL_CERT_FILE/NODE_EXTRA_CA_CERTS)
 * and the combined bundle `{public roots} ∪ {proxy CA}` (replace-semantics
 * trust for the own-bundle tools — CURL_CA_BUNDLE & friends). Skips the write
 * when both stored values already match (the common case — the proxy persists
 * its CA in /data and only regenerates when that volume is lost).
 */
export async function ensureCaConfigMap(caPem: string, caBundlePem: string): Promise<void> {
  const existing = await kubectlGetJson<RawConfigMap>([
    'get', 'configmap', CA_CONFIGMAP_NAME, '-n', k8sNamespace(),
  ])
  if (
    existing?.data?.[CA_CONFIGMAP_KEY] === caPem &&
    existing?.data?.[CA_BUNDLE_KEY] === caBundlePem
  ) return
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: CA_CONFIGMAP_NAME, namespace: k8sNamespace() },
    data: { [CA_CONFIGMAP_KEY]: caPem, [CA_BUNDLE_KEY]: caBundlePem },
  })
}
