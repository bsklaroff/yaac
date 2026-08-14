import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  CA_BUNDLE_KEY,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  LABEL_ROLE,
  PRIVILEGED_PSS_LABELS,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  ROLE_BUILDER,
} from '#drivers/k8s/substrate'
import { credentialsDir, proxyDataHostDir } from '@yaac/shared/project-paths'
import {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildProxyDeploymentManifest,
  buildProxyRoleBindingManifest,
  buildProxyRoleManifest,
  buildProxyServiceAccountManifest,
  buildProxyServiceManifest,
} from './proxy-manifests'
import {
  buildEgressWorldDenyNpManifest,
  buildProxyIngressNpManifest,
  buildWorktreeEgressNpManifest,
  buildWorktreeIngressLockNpManifest,
} from './policy-manifests'
import { nodeIpBlocks } from './cluster-cidrs'
import { ensureNetd } from './netd'

/** True when the cluster serves the ValidatingAdmissionPolicy API. */
export async function vapAvailable(): Promise<boolean> {
  try {
    await kubectlWithRetry(
      ['get', 'validatingadmissionpolicies', '-o', 'name'],
      { maxAttempts: 1, timeout: 15_000 },
    )
    return true
  } catch {
    return false
  }
}

/**
 * The install namespace, labelled for the `privileged` Pod Security
 * Standard (see PRIVILEGED_PSS_LABELS for what that admits and why).
 */
export async function ensureNamespace(): Promise<void> {
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: k8sNamespace(), labels: { ...PRIVILEGED_PSS_LABELS } },
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
 * The live ClusterIP of the proxy Service — read at pod-create as the worktree
 * pods' DNS nameserver + egress redirect target. Allocator-assigned (no longer
 * pinned), and stable because the Service is never deleted/recreated.
 * That stability is why the first read is cached for the process — it saves a
 * kubectl child per worktree create.
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

export async function ensureProxyResources(imageRef: string): Promise<void> {
  // Pre-create the credentials dir with tight permissions before any pod
  // mounts it — DirectoryOrCreate would make it root-owned 0755.
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(proxyDataHostDir(), { recursive: true })

  // SA + RBAC before the Deployment, which references the SA so the proxy
  // can watch pods (source-IP → worktree). The Service's ClusterIP is
  // allocator-assigned and never deleted, so `apply` is a no-op on it after
  // first creation — no immutable-field migration needed (the pin is gone).
  await kubectlApply(buildProxyServiceAccountManifest())
  await kubectlApply(buildProxyRoleManifest())
  await kubectlApply(buildProxyRoleBindingManifest())
  await kubectlApply(buildProxyDeploymentManifest(imageRef))
  await kubectlApply(buildProxyServiceManifest())
  // The egress lockdown, applied with the proxy so it exists before any
  // worktree pod can be scheduled (worktrees require ensureRunning()).
  const nodeCidrs = await nodeIpBlocks()
  await kubectlApply(buildWorktreeEgressNpManifest(nodeCidrs))
  // Worktree-pod ingress lock: only the proxy's relay dials reach streamd;
  // everything else is default-denied. Applied with the proxy for the same
  // exists-before-any-worktree reason as the egress lockdown.
  await kubectlApply(buildWorktreeIngressLockNpManifest())
  // Lock the proxy's transparent ports to the node (forgery guard): only
  // netd's Envoy, which runs in the node netns, may originate PP2.
  await kubectlApply(buildProxyIngressNpManifest(nodeCidrs))
  // World-egress default-deny over non-worktree, non-builder pods.
  await kubectlApply(buildEgressWorldDenyNpManifest())
  // The redirect layer.
  await ensureNetd()
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
 * Upsert the proxy-CA ConfigMap that every worktree pod mounts. Carries two
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

/**
 * Cluster-wide admission guard reserving the `yaac.role=builder` label:
 * no ServiceAccount (the only identity untrusted code can hold) may create
 * or update a pod carrying it, and carriers must run under the gvisor
 * RuntimeClass.
 * Fail-closed: the label excludes its pods from the world-deny egress
 * policy, so builders must not run on a cluster that cannot enforce the
 * reservation. Applied idempotently by `yaac cluster setup` and again by
 * the builder pool before it leases a pod.
 *
 * Lives here, not with the builder pool it guards: it applies this
 * feature's own manifests to this feature's cluster, and cluster setup
 * calls it. Housing it in #drivers/k8s/images meant cluster setup imported
 * the feature that sits above it.
 */
export async function ensureBuilderRoleGuard(): Promise<void> {
  if (!await vapAvailable()) {
    throw new Error(
      'sandboxed image builds need the ValidatingAdmissionPolicy API to '
      + `reserve the ${LABEL_ROLE}=${ROLE_BUILDER} pod label (kubernetes `
      + '>= 1.30). Recreate the cluster with `yaac cluster setup`.',
    )
  }
  await kubectlApply(buildBuilderRoleGuardPolicyManifest())
  await kubectlApply(buildBuilderRoleGuardBindingManifest())
}
