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
  LABEL_WORKSPACE_ID,
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

/** The workspace-id label an install from before workspaces were named
 *  stamped, in place of LABEL_WORKSPACE_ID. */
const LEGACY_WORKSPACE_ID_LABEL = 'yaac.worktree-id'

/**
 * Give every pod, Job and proxy registration an older install labelled with
 * LEGACY_WORKSPACE_ID_LABEL the current label too, so the workspaces it left
 * running are seen, governed by the current policies and served by the
 * proxy (docs/legacy-compat-shims.md). The old label stays: until the proxy
 * rolls, it is still the one the running proxy and policies select on.
 * True when there was anything to relabel.
 */
export async function relabelLegacyWorkspaces(): Promise<boolean> {
  let found = false
  for (const kind of ['pods', 'jobs', 'configmaps']) {
    const list = await kubectlGetJson<{ items?: Array<{ metadata: { name: string; labels: Record<string, string> } }> }>([
      'get', kind, '-n', k8sNamespace(), '-l', `${LEGACY_WORKSPACE_ID_LABEL},!${LABEL_WORKSPACE_ID}`,
    ])
    for (const { metadata } of list?.items ?? []) {
      found = true
      await kubectlWithRetry([
        'label', kind, metadata.name, '-n', k8sNamespace(),
        `${LABEL_WORKSPACE_ID}=${metadata.labels[LEGACY_WORKSPACE_ID_LABEL]}`, '--overwrite',
      ])
    }
  }
  return found
}

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
 * The live ClusterIP of the proxy Service — read at pod-create as the workspace
 * pods' DNS nameserver + egress redirect target. Allocator-assigned (no longer
 * pinned), and stable because the Service is never deleted/recreated.
 * That stability is why the first read is cached for the process — it saves a
 * kubectl child per workspace create.
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
  // SA + RBAC before the Deployment, which references the SA so the proxy
  // can watch pods and its input objects and write its outputs. The
  // Service's ClusterIP is allocator-assigned and never deleted, so
  // `apply` is a no-op on it after first creation — no immutable-field
  // migration needed (the pin is gone).
  await kubectlApply(buildProxyServiceAccountManifest())
  await kubectlApply(buildProxyRoleManifest())
  await kubectlApply(buildProxyRoleBindingManifest())
  // The three objects the proxy writes, created empty so its Role can name
  // them — and only when absent, since an apply of the empty shape onto a
  // live one would wipe what the proxy wrote. Before the Deployment, so
  // the pod never boots against a name it cannot patch.
  for (const manifest of buildProxyOutputManifests()) {
    const { kind, metadata } = manifest as { kind: string; metadata: { name: string } }
    const existing = await kubectlGetJson<object>(['get', kind.toLowerCase(), metadata.name, '-n', k8sNamespace()])
    if (!existing) await kubectlApply(manifest)
  }
  await kubectlApply(buildProxyDeploymentManifest(imageRef))
  await kubectlApply(buildProxyServiceManifest())
  // The egress lockdown, applied with the proxy so it exists before any
  // workspace pod can be scheduled (workspaces require ensureRunning()).
  const nodeCidrs = await nodeIpBlocks()
  await kubectlApply(buildWorkspaceEgressNpManifest(nodeCidrs))
  // Workspace-pod ingress lock: only the proxy's relay dials reach streamd;
  // everything else is default-denied. Applied with the proxy for the same
  // exists-before-any-workspace reason as the egress lockdown.
  await kubectlApply(buildWorkspaceIngressLockNpManifest())
  // Lock the proxy's transparent ports to the node (forgery guard): only
  // netd's Envoy, which runs in the node netns, may originate PP2.
  await kubectlApply(buildProxyIngressNpManifest(nodeCidrs))
  // And its upstream dials kept off the kind fronting's node port, where a
  // transparent CONNECT would otherwise reach the server as the node.
  await kubectlApply(buildProxyEgressNpManifest(nodeCidrs))
  // World-egress default-deny over non-workspace, non-builder pods.
  await kubectlApply(buildEgressWorldDenyNpManifest())
  // Only once their replacements govern every pod an older install left
  // running (docs/legacy-compat-shims.md). The relabel is repeated here,
  // and not only at driver start, so every path that can reach this delete
  // (a create racing startup, a start whose relabel failed) finishes it
  // first — and a relabel that throws never gets this far.
  await relabelLegacyWorkspaces()
  await kubectlWithRetry([
    'delete', 'networkpolicy', 'yaac-worktree-egress', 'yaac-worktree-ingress-lock',
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
  // The redirect layer.
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
 * Upsert the proxy-CA ConfigMap that every workspace pod mounts, from the
 * Secret the proxy keeps its CA in. Carries two keys: the bare proxy CA
 * (additive trust — SSL_CERT_FILE/NODE_EXTRA_CA_CERTS) and the combined
 * bundle `{public roots} ∪ {proxy CA}` (replace-semantics trust for the
 * own-bundle tools — CURL_CA_BUNDLE & friends). Skips the write when both
 * stored values already match (the common case — the CA lives for the
 * install, and only the bundle moves when the image's roots do).
 *
 * The proxy writes the Secret before it starts listening, so a proxy that
 * answers `/healthz` has written it; the wait covers the moment between.
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
 * Hand the proxy the whole credential set — the host-store files and the
 * ssh keys — by replacing its credentials Secret. Applied whether or not a
 * proxy is deployed yet: the object is what the first one boots from.
 * Never logs a value.
 */
export async function syncProxyCredentials(bundle: CredentialBundle): Promise<void> {
  await kubectlApply(buildProxyCredentialsSecretManifest(bundle))
  const signedIn = (['claude', 'codex', 'opencode', 'pi'] as const).filter((t) => bundle[t] !== null)
  serverLog(`[server] proxy credentials: ${signedIn.length ? signedIn.join(', ') : 'no tools'} signed in, `
    + `${String(bundle.git.length)} git token(s), ${String(bundle.ssh.length)} ssh key(s)`)
}

/** Hand the proxy one project's opened secret values, replacing what it
 *  held for that project. An emptied set is applied as such, so a deleted
 *  secret stops being injected. */
export async function syncProjectSecrets(
  projectSlug: string,
  values: Record<string, string>,
): Promise<void> {
  await kubectlApply(buildProjectSecretsManifest(projectSlug, values))
}

/** Forget a project's secret values — the object goes with the project. */
export async function removeProjectSecrets(projectSlug: string): Promise<void> {
  await kubectlWithRetry([
    'delete', 'secret', proxyProjectSecretsName(projectSlug),
    '-n', k8sNamespace(), '--ignore-not-found',
  ])
}

/**
 * Cluster-wide admission guard reserving the `yaac.role=builder` label:
 * no ServiceAccount (the only identity untrusted code can hold) may create
 * or update a pod carrying it, and carriers must run under the gvisor
 * RuntimeClass.
 * Fail-closed: the label excludes its pods from the world-deny egress
 * policy, so builders must not run on a cluster that cannot enforce the
 * reservation. Applied idempotently by `yaac cluster install` and again by
 * the builder pool before it leases a pod.
 *
 * Lives here, not with the builder pool it guards: it applies this
 * feature's own manifests to this feature's cluster, and cluster install
 * calls it. Housing it in #drivers/k8s/images meant cluster install imported
 * the feature that sits above it.
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
