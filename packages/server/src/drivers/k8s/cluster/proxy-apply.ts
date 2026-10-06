import crypto from 'node:crypto'
import {
  CA_BUNDLE_KEY,
  CA_CONFIGMAP_KEY,
  CA_CONFIGMAP_NAME,
  apiStatus,
  applyObject,
  createObject,
  deleteObject,
  deleteObjects,
  isAbsent,
  k8sNamespace,
  listObjects,
  readObject,
  LABEL_PROXY_INPUT,
  LABEL_ROLE,
  PRIVILEGED_PSS_LABELS,
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_CA_SECRET_NAME,
  ROLE_BUILDER,
  readProxyAuthSecret,
  waitForRollout,
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
  buildServerMamaServiceManifest,
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

/**
 * True when the cluster serves the ValidatingAdmissionPolicy API. A failure
 * other than absence (e.g. an RBAC denial) is thrown, not read as "no".
 */
export async function vapAvailable(): Promise<boolean> {
  try {
    await listObjects('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy')
    return true
  } catch (err) {
    if (isAbsent(err)) return false
    throw err
  }
}

/**
 * The install namespace, labelled for the `privileged` Pod Security
 * Standard (see PRIVILEGED_PSS_LABELS for what that admits and why).
 */
export async function ensureNamespace(): Promise<void> {
  await applyObject({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: k8sNamespace(), labels: { ...PRIVILEGED_PSS_LABELS } },
  })
}

/** Ensure the proxy auth Secret exists (generated once per cluster) and
 *  return its value. */
export async function ensureProxyAuthSecret(): Promise<string> {
  const existing = await readProxyAuthSecret()
  if (existing) return existing

  const secret = crypto.randomBytes(32).toString('hex')
  await applyObject({
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
  const svc = await readObject<{ spec?: { clusterIP?: string } }>({
    apiVersion: 'v1', kind: 'Service', name: PROXY_APP_NAME, namespace: k8sNamespace(),
  })
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
  // The objects the proxy writes, created empty (so its Role can name them)
  // only if absent, since applying over them would wipe its output.
  for (const manifest of buildProxyOutputManifests()) {
    await createObject(manifest).catch((err: unknown) => {
      if (apiStatus(err) !== 409) throw err
    })
  }
  const nodeCidrs = await nodeIpBlocks()
  // In order: RBAC before the Deployment that uses it, and the policies
  // with the proxy, before any workspace pod can exist.
  for (const manifest of [
    buildProxyServiceAccountManifest(),
    buildProxyRoleManifest(),
    buildProxyRoleBindingManifest(),
    buildProxyDeploymentManifest(imageRef),
    buildProxyServiceManifest(),
    buildServerMamaServiceManifest(),
    buildWorkspaceEgressNpManifest(nodeCidrs),
    buildWorkspaceIngressLockNpManifest(),
    buildProxyIngressNpManifest(nodeCidrs),
    buildProxyEgressNpManifest(nodeCidrs),
    buildEgressWorldDenyNpManifest(),
  ]) await applyObject(manifest)
  await ensureNetd()
  await waitForRollout({
    workload: `deployment/${PROXY_APP_NAME}`, namespace: k8sNamespace(), timeoutMs: 180_000,
  })
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
    const secret = await readObject<RawObject>({
      apiVersion: 'v1', kind: 'Secret', name: PROXY_CA_SECRET_NAME, namespace: k8sNamespace(),
    })
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
  const existing = await readObject<RawObject>({
    apiVersion: 'v1', kind: 'ConfigMap', name: CA_CONFIGMAP_NAME, namespace: k8sNamespace(),
  })
  if (
    existing?.data?.[CA_CONFIGMAP_KEY] === caPem &&
    existing?.data?.[CA_BUNDLE_KEY] === caBundlePem
  ) return
  await applyObject({
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
  await applyObject(buildProxyCredentialsSecretManifest(bundle))
  const signedIn = (['claude', 'codex', 'opencode', 'pi'] as const).filter((t) => bundle[t] !== null)
  serverLog(`[server] proxy credentials: ${signedIn.length ? signedIn.join(', ') : 'no tools'} signed in, `
    + `${String(bundle.git.length)} git token(s), ${String(bundle.ssh.length)} ssh key(s)`)
}

/** Replace one project's secret values for the proxy (an empty set is
 *  applied too, so deleted secrets stop being injected). */
export async function syncProjectSecrets(
  projectId: string,
  values: Record<string, string>,
): Promise<void> {
  await applyObject(buildProjectSecretsManifest(projectId, values))
}

/**
 * Delete the secret values objects named by project slug, which only those
 * still label `yaac.project` (id-named ones carry `yaac.project-id`). A
 * legacy-compat sweep: see docs/legacy-compat-shims.md.
 */
export async function deleteSlugNamedProjectSecrets(): Promise<void> {
  await deleteObjects('v1', 'Secret', {
    namespace: k8sNamespace(), labelSelector: `app=${PROXY_APP_NAME},${LABEL_PROXY_INPUT}=secrets,yaac.project`,
  })
}

/** Delete a project's secret values object. */
export async function removeProjectSecrets(projectId: string): Promise<void> {
  await deleteObject({
    apiVersion: 'v1', kind: 'Secret', name: proxyProjectSecretsName(projectId), namespace: k8sNamespace(),
  })
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
      + `reserve the ${LABEL_ROLE}=${ROLE_BUILDER} pod label, which Kubernetes `
      + 'serves from 1.30. Upgrade the control plane to 1.30 or later; for a kind '
      + 'cluster yaac created, run `yaac cluster delete`, then `yaac cluster install`.',
    )
  }
  await applyObject(buildBuilderRoleGuardPolicyManifest())
  await applyObject(buildBuilderRoleGuardBindingManifest())
}
