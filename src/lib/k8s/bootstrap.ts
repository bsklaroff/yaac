import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { CA_CONFIGMAP_KEY, CA_CONFIGMAP_NAME } from '@/lib/k8s/pod-spec'
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
 * Per-pod relay: the redirect init container REDIRECTs outbound 443 to the
 * relay's HTTPS loopback port and outbound 80 to its HTTP port. Two ports
 * (not one) carry the original protocol to the relay without
 * SO_ORIGINAL_DST, keeping the relay pure Node. The relay forwards to the
 * proxy's matching transparent listener with a PP2 identity header.
 * 1500x / uid 1337 mirror Istio's well-known relay values.
 */
export const RELAY_HTTPS_PORT = 15001
export const RELAY_HTTP_PORT = 15002
/** Loopback port git's ncat ProxyCommand sends its CONNECT to. */
export const RELAY_CONNECT_PORT = 15003
/**
 * Loopback UDP port of the relay's DNS stub. The redirect init container
 * REDIRECTs all outbound udp/53 here — including queries aimed at the
 * kube-dns VIP — so DNS never leaves the pod: the stub answers every A
 * query with a fixed dummy IP, which is all a client needs — the 443/80
 * REDIRECT ignores the dialed IP and the proxy routes by SNI/Host.
 */
export const RELAY_DNS_PORT = 15004
export const RELAY_UID = 1337
/**
 * The cluster's service subnet, pinned in k8s/kind-config.yaml.
 * clusterIpForNamespace hashes the proxy Service's pinned VIP into this
 * compiled value, so a drifted live cluster would fail Service creation
 * ("provided IP is not in the valid range") — `yaac cluster check`
 * warns on drift.
 */
export const CLUSTER_SERVICE_CIDR = '10.96.0.0/16'
/** NetworkPolicy restricting session-pod egress to the proxy. */
export const SESSION_NETWORK_POLICY_NAME = 'yaac-session-egress'

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
export function buildProxyDeploymentManifest(imageRef: string): Record<string, unknown> {
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
        metadata: { labels: { app: PROXY_APP_NAME } },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...proxyRunAsSecurityContext(),
          containers: [
            {
              name: 'proxy',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              ports: [
                { containerPort: PROXY_PORT },
                { containerPort: TRANSPARENT_HTTPS_PORT },
                { containerPort: TRANSPARENT_HTTP_PORT },
                { containerPort: TRANSPARENT_TUNNEL_PORT },
              ],
              env: [
                { name: 'API_PORT', value: String(PROXY_PORT) },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
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
          ],
        },
      },
    },
  }
}

/**
 * Build the NetworkPolicy that makes the proxy's allowlist mandatory at
 * the network layer. Without it the allowlist is advisory: an agent that
 * opens raw sockets to in-cluster IPs (which the pod-netns redirect
 * RETURNs) would have free egress there. The policy selects every
 * session pod (any pod carrying the session-id label) and allows egress
 * ONLY to proxy pods (`app: yaac-proxy`) on the transparent transport
 * ports — Service-VIP traffic matches because policies evaluate
 * post-DNAT against the backend pod's labels.
 *
 * Deliberately absent:
 *   - the explicit proxy port 10255: nothing in session pods dials it
 *     (the daemon's control API rides `kubectl port-forward`, not the
 *     pod network)
 *   - kube-dns: queries never leave the pod — the redirect init
 *     container REDIRECTs udp/53 to the relay's loopback DNS stub, which
 *     closes the DNS-tunneling channel entirely
 *
 * This is the pod-scoped backstop under the in-pod filter default-deny
 * (k8s/redirect-init/redirect.sh), which additionally distinguishes the
 * relay container from the session container — something NetworkPolicy
 * cannot do (they share the pod IP). End state: session pods reach
 * exactly {proxy pods} x {transparent ports}, and within the pod only
 * the relay uid can do even that.
 *
 * No Ingress rules on purpose: nothing reaches session pods over the pod
 * network — exec, PTY attach, and port relays all ride `kubectl exec`
 * through the kubelet, which NetworkPolicy does not mediate. Note the
 * policy only bites on a CNI that enforces NetworkPolicy (kind's kindnet
 * does); `yaac cluster check` probes enforcement end to end.
 */
export function buildSessionNetworkPolicyManifest(): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: SESSION_NETWORK_POLICY_NAME,
      namespace: k8sNamespace(),
      labels: { app: PROXY_APP_NAME },
    },
    spec: {
      podSelector: {
        matchExpressions: [{ key: LABEL_SESSION_ID, operator: 'Exists' }],
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { app: PROXY_APP_NAME } } }],
          // Transport ports, not 443/80: redirected packets are DNAT'd to
          // the proxy's transparent listeners in the pod netns *before*
          // policy evaluation, which runs post-DNAT against the proxy pod.
          ports: [
            { protocol: 'TCP', port: TRANSPARENT_HTTPS_PORT },
            { protocol: 'TCP', port: TRANSPARENT_HTTP_PORT },
            { protocol: 'TCP', port: TRANSPARENT_TUNNEL_PORT },
          ],
        },
      ],
    },
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
 * NotIn also matches pods with no `app` label, so it catches session
 * pods, registries, mocks, and anything added later. The exemption label
 * can only be set by the trusted daemon on its own pods (session/synced
 * pods never carry it), so it is not a forge vector.
 *
 * Namespace-scoped, not cluster-wide on purpose: a cluster-wide deny
 * would also hit kube-system CoreDNS (whose upstream forwarding the proxy
 * needs to resolve external hosts) and the Cilium/system pods. vcluster
 * synced pods live in their OWN per-session namespaces, each blanketed by
 * its own deny (buildVclusterNamespaceWorldDenyManifest in vcluster.ts),
 * so they are covered there rather than here.
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
        matchExpressions: [{ key: 'app', operator: 'NotIn', values: [PROXY_APP_NAME] }],
      },
      egressDeny: [{ toEntities: ['world'] }],
    },
  }
}

export function buildProxyServiceManifest(): Record<string, unknown> {
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
      // Pinned, not allocator-assigned: session relays dial this VIP from
      // env (no DNS), and the pin makes it reproducible across Service
      // recreation — see clusterIpForNamespace.
      clusterIP: clusterIpForNamespace(k8sNamespace()),
      selector: { app: PROXY_APP_NAME },
      // port == targetPort throughout: the NetworkPolicy and the in-pod
      // egress filter list the post-translation (transport) port, so a
      // remap would make policy and Service silently diverge.
      ports: [
        { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT },
        { name: 'transparent-https', port: TRANSPARENT_HTTPS_PORT, targetPort: TRANSPARENT_HTTPS_PORT },
        { name: 'transparent-http', port: TRANSPARENT_HTTP_PORT, targetPort: TRANSPARENT_HTTP_PORT },
        { name: 'transparent-tunnel', port: TRANSPARENT_TUNNEL_PORT, targetPort: TRANSPARENT_TUNNEL_PORT },
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
export async function ensureProxyResources(imageRef: string): Promise<void> {
  // Pre-create the credentials dir with tight permissions before any pod
  // mounts it — DirectoryOrCreate would make it root-owned 0755.
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(sshAgentHostDir(), { recursive: true })
  await fs.mkdir(proxyDataHostDir(), { recursive: true })

  // One-time migration to the pinned VIP: spec.clusterIP is immutable, so
  // on a cluster whose Service predates the pin (or drifted) the apply
  // would fail with "field is immutable" — delete and let the apply below
  // recreate it at the pinned address. Pre-migration sessions are safe
  // across the swap: their relays still hold the proxy's DNS name and
  // Node re-resolves it on every connection.
  const live = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', PROXY_APP_NAME, '-n', k8sNamespace(),
  ])
  if (live && live.spec?.clusterIP !== clusterIpForNamespace(k8sNamespace())) {
    await kubectlWithRetry([
      'delete', 'service', PROXY_APP_NAME, '-n', k8sNamespace(), '--ignore-not-found',
    ])
  }

  await kubectlApply(buildProxyDeploymentManifest(imageRef))
  await kubectlApply(buildProxyServiceManifest())
  // Applied with the proxy resources so the egress lockdown exists before
  // any session pod can be scheduled (sessions require ensureRunning()).
  await kubectlApply(buildSessionNetworkPolicyManifest())
  // Blanket world-egress deny over session + vcluster synced pods — the
  // authoritative backstop a vcluster tenant cannot widen (see builder).
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
 * Upsert the proxy-CA ConfigMap that every session pod mounts. Skips the
 * write when the stored PEM already matches (the common case — the proxy
 * persists its CA in /data and only regenerates when that volume is lost).
 */
export async function ensureCaConfigMap(caPem: string): Promise<void> {
  const existing = await kubectlGetJson<RawConfigMap>([
    'get', 'configmap', CA_CONFIGMAP_NAME, '-n', k8sNamespace(),
  ])
  if (existing?.data?.[CA_CONFIGMAP_KEY] === caPem) return
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: CA_CONFIGMAP_NAME, namespace: k8sNamespace() },
    data: { [CA_CONFIGMAP_KEY]: caPem },
  })
}
