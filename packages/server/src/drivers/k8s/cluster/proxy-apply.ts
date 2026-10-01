import crypto from 'node:crypto'
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
  PROXY_CA_SECRET_NAME,
  ROLE_BUILDER,
} from '#drivers/k8s/substrate'
import type { CredentialBundle } from '#drivers/contract'
import { serverLog } from '#log'
import {
  buildBuilderRoleGuardBindingManifest,
  buildBuilderRoleGuardPolicyManifest,
  buildProjectSecretsManifest,
  buildProxyCredentialsSecretManifest,
  buildProxyDeploymentManifest,
  buildProxyOutputManifests,
  buildProxyRoleBindingManifest,
  buildProxyRoleManifest,
  buildProxyServiceAccountManifest,
  buildProxyServiceManifest,
  proxyProjectSecretsName,
} from './proxy-manifests'
import {
  buildEgressWorldDenyNpManifest,
  buildProxyEgressNpManifest,
  buildProxyIngressNpManifest,
  buildWorkspaceEgressNpManifest,
  buildWorkspaceIngressLockNpManifest,
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

/** Ensure the proxy auth Secret exists (generated once per cluster) and
 *  return its value. */
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
 * The proxy Service's ClusterIP: workspace pods' DNS server and redirect
 * target. Cached, since the Service is never recreated while in use.
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

/** Forget the cached ClusterIP (after the Service is deleted, and in
 *  tests). */
export function resetProxyClusterIpCache(): void {
  cachedProxyClusterIp = null
}

export async function ensureProxyResources(imageRef: string): Promise<void> {
  // RBAC before the Deployment that uses it.
  await kubectlApply(buildProxyServiceAccountManifest())
  await kubectlApply(buildProxyRoleManifest())
  await kubectlApply(buildProxyRoleBindingManifest())
  // The objects the proxy writes, created empty (so its Role can name them)
  // only if absent, since applying over them would wipe its output.
  for (const manifest of buildProxyOutputManifests()) {
    const { kind, metadata } = manifest as { kind: string; metadata: { name: string } }
    const existing = await kubectlGetJson<object>(['get', kind.toLowerCase(), metadata.name, '-n', k8sNamespace()])
    if (!existing) await kubectlApply(manifest)
  }
  await kubectlApply(buildProxyDeploymentManifest(imageRef))
  await kubectlApply(buildProxyServiceManifest())
  // Policies go on with the proxy, before any workspace pod can exist.
  const nodeCidrs = await nodeIpBlocks()
  await kubectlApply(buildWorkspaceEgressNpManifest(nodeCidrs))
  await kubectlApply(buildWorkspaceIngressLockNpManifest())
  await kubectlApply(buildProxyIngressNpManifest(nodeCidrs))
  await kubectlApply(buildProxyEgressNpManifest(nodeCidrs))
  await kubectlApply(buildEgressWorldDenyNpManifest())
  await ensureNetd()
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${PROXY_APP_NAME}`,
    '-n', k8sNamespace(),
    '--timeout=180s',
  ], { timeout: 190_000, maxAttempts: 2 })
}

interface RawObject {
  data?: Record<string, string>
}

/** How long to wait for a freshly rolled proxy to have written its CA. */
const CA_WAIT_MS = 30_000

/**
 * Upsert the proxy-CA ConfigMap that workspace pods mount, from the proxy's
 * CA Secret. Two keys: the bare CA (for tools that add to the system trust,
 * e.g. NODE_EXTRA_CA_CERTS) and public roots plus the CA (for tools that
 * replace it, e.g. CURL_CA_BUNDLE). Skips the write if unchanged. Waits
 * briefly for a freshly rolled proxy to write the Secret.
 */
export async function ensureCaConfigMap(): Promise<void> {
  const deadline = Date.now() + CA_WAIT_MS
  let caPem: string | undefined
  let caBundlePem: string | undefined
  for (;;) {
    const secret = await kubectlGetJson<RawObject>([
      'get', 'secret', PROXY_CA_SECRET_NAME, '-n', k8sNamespace(),
    ])
    const decode = (key: string): string | undefined => {
      const encoded = secret?.data?.[key]
      return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined
    }
    caPem = decode('ca.pem')
    caBundlePem = decode('ca-bundle.pem')
    if (caPem && caBundlePem) break
    if (Date.now() >= deadline) {
      throw new Error(`the proxy has not written its CA to ${PROXY_CA_SECRET_NAME}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const existing = await kubectlGetJson<RawObject>([
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
 * Replace the proxy's credentials Secret with the whole credential set.
 * Applied even before the proxy exists, since it boots from it. Never logs
 * values.
 */
export async function syncProxyCredentials(bundle: CredentialBundle): Promise<void> {
  await kubectlApply(buildProxyCredentialsSecretManifest(bundle))
  const signedIn = (['claude', 'codex', 'opencode', 'pi'] as const).filter((t) => bundle[t] !== null)
  serverLog(`[server] proxy credentials: ${signedIn.length ? signedIn.join(', ') : 'no tools'} signed in, `
    + `${String(bundle.git.length)} git token(s), ${String(bundle.ssh.length)} ssh key(s)`)
}

/** Replace one project's secret values for the proxy (an empty set is
 *  applied too, so deleted secrets stop being injected). */
export async function syncProjectSecrets(
  projectSlug: string,
  values: Record<string, string>,
): Promise<void> {
  await kubectlApply(buildProjectSecretsManifest(projectSlug, values))
}

/** Delete a project's secret values object. */
export async function removeProjectSecrets(projectSlug: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'secret', proxyProjectSecretsName(projectSlug),
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
}

/**
 * Admission guard reserving the `yaac.role=builder` label: no
 * ServiceAccount (the only identity untrusted code can hold) may set it, and
 * its pods must run under gVisor. The label exempts pods from the
 * world-deny policy, so builders refuse to run where this cannot be
 * enforced. Applied by `yaac cluster install` and by the builder pool.
 */
export async function ensureBuilderRoleGuard(): Promise<void> {
  if (!await vapAvailable()) {
    throw new Error(
      'sandboxed image builds need the ValidatingAdmissionPolicy API to '
      + `reserve the ${LABEL_ROLE}=${ROLE_BUILDER} pod label (kubernetes `
      + '>= 1.30). Recreate the cluster with `yaac cluster install`.',
    )
  }
  await kubectlApply(buildBuilderRoleGuardPolicyManifest())
  await kubectlApply(buildBuilderRoleGuardBindingManifest())
}
