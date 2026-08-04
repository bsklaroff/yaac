import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CA_BUNDLE_KEY,
  CA_CERT_PATH,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#platform/k8s'
import { credentialsDir, getDataDir } from '@yaac/shared/project-paths'
import {
  buildOuterProxyCaConfigMapManifest,
  buildProxyDeploymentManifest,
  buildProxyRoleBindingManifest,
  buildProxyRoleManifest,
  buildProxyServiceAccountManifest,
  buildProxyServiceManifest,
} from './proxy-manifests'
import {
  buildEgressWorldDenyNpManifest,
  buildProxyIngressNpManifest,
  buildSessionEgressNpManifest,
  buildSessionIngressLockNpManifest,
} from './policy-manifests'
import { nodeIpBlocks } from './cluster-cidrs'
import { ensureNetd } from './netd'

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
 * generated once per cluster and read back on every server start —
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

let cachedProxyClusterIp: string | null = null

/**
 * The live ClusterIP of the proxy Service — read at pod-create as the session
 * pods' DNS nameserver + egress redirect target. Allocator-assigned (no longer
 * pinned) for both the top-level and the vcluster-allocated inner proxy; stable
 * because the Service is never deleted/recreated. (The spike confirmed synced
 * pods reach vcluster ClusterIPs and that an explicit dnsConfig survives sync.)
 * That stability is why the first read is cached for the process — it saves a
 * kubectl child per session create.
 */
export async function proxyServiceClusterIp(): Promise<string> {
  if (cachedProxyClusterIp) return cachedProxyClusterIp
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', PROXY_APP_NAME, '-n', k8sNamespace(),
  ])
  const ip = svc?.spec?.clusterIP
  if (!ip) throw new Error('proxy Service has no ClusterIP yet')
  cachedProxyClusterIp = ip
  return ip
}

/**
 * Forget the cached proxy Service ClusterIP. Called from ProxyClient.stop()
 * (the Service is deleted with the Deployment there, so a later ensure may
 * allocate a new IP) and from test setup.
 */
export function resetProxyClusterIpCache(): void {
  cachedProxyClusterIp = null
}

export async function ensureProxyResources(
  imageRef: string,
  opts: { nested?: boolean } = {},
): Promise<void> {
  // Pre-create the credentials dir with tight permissions before any pod
  // mounts it — DirectoryOrCreate would make it root-owned 0755.
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(proxyDataHostDir(), { recursive: true })

  // Nested (inner) yaac: NetworkPolicy is a core API every vcluster
  // already serves, so an inner install's policies apply with no CRD
  // registration step of any kind.
  if (opts.nested) {
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

  // SA + RBAC before the Deployment, which references the SA so the proxy
  // can watch pods (source-IP → session). The Service's ClusterIP is
  // allocator-assigned and never deleted, so `apply` is a no-op on it after
  // first creation — no immutable-field migration needed (the pin is gone).
  await kubectlApply(buildProxyServiceAccountManifest())
  await kubectlApply(buildProxyRoleManifest())
  await kubectlApply(buildProxyRoleBindingManifest())
  await kubectlApply(buildProxyDeploymentManifest(imageRef, opts))
  await kubectlApply(buildProxyServiceManifest())
  // The egress lockdown, applied with the proxy so it exists before any
  // session pod can be scheduled (sessions require ensureRunning()).
  const nodeCidrs = await nodeIpBlocks()
  await kubectlApply(buildSessionEgressNpManifest(nodeCidrs))
  // Session-pod ingress lock: only the proxy's relay dials reach streamd;
  // everything else is default-denied. Applied with the proxy for the same
  // exists-before-any-session reason as the egress lockdown.
  await kubectlApply(buildSessionIngressLockNpManifest())
  // Lock the proxy's transparent ports to the node (forgery guard): only
  // netd's Envoy, which runs in the node netns, may originate PP2.
  await kubectlApply(buildProxyIngressNpManifest(nodeCidrs))
  // World-egress default-deny over non-session, non-builder pods.
  await kubectlApply(buildEgressWorldDenyNpManifest())
  // The redirect layer. A nested install runs netd in CLAIM mode: its
  // vcluster has no nodes, so it publishes what it wants redirected and the
  // host validates and programs it (docs/nested-containers.md).
  await ensureNetd({ nested: opts.nested ?? false })
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
