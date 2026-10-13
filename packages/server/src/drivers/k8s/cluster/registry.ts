import { env, testEnv } from '@yaac/shared/env'
import { invalidatePortForward, resolvePortForward } from '#drivers/k8s/substrate'

/**
 * Client for the main OCI registry (the workload is main-registry.ts). It
 * has two addresses:
 *
 *  - `registryHost()`: the cluster address, the only one in image refs.
 *    Pods and node containerd use it.
 *  - `registryEndpoint()`: where this process reaches it. The Service
 *    directly when in-cluster, else a `kubectl port-forward`.
 *
 * The registry stores by repository path, so a push to any endpoint and a
 * pull by the cluster ref see the same bytes. Pushes are the install's
 * (`#drivers/k8s/install`), since only it runs a container engine.
 */

/** Service (and Deployment) name of the in-cluster registry. */
export const REGISTRY_SERVICE_NAME = 'yaac-registry'

/** In-cluster port. Not 443/80, which netd redirects to the proxy. */
export const REGISTRY_SERVICE_PORT = 5000

/**
 * The registry's namespace: the default install namespace, not
 * `k8sNamespace()`, so per-run e2e namespaces share one image store and the
 * node hosts.toml never changes.
 */
export const REGISTRY_NAMESPACE = 'yaac'

/** Key for this process's registry port-forward. */
const REGISTRY_FORWARD_KEY = 'main-registry'

/**
 * The host:port in image refs: a full `.svc.cluster.local` name, which the
 * proxy's DNS forwards to CoreDNS. Node containerd matches it against the
 * hosts.toml main-registry.ts writes instead of resolving it.
 */
export function registryHost(): string {
  return `${REGISTRY_SERVICE_NAME}.${REGISTRY_NAMESPACE}.svc.cluster.local:${REGISTRY_SERVICE_PORT}`
}

/** Full in-cluster image ref for a locally built `repo:tag`. */
export function registryRef(tag: string): string {
  return `${registryHost()}/${tag}`
}

/**
 * Where this process reaches the registry: the Service when in-cluster,
 * else a shared port-forward started on first use. Throws if the forward
 * cannot be established (e.g. no registry Deployment).
 */
export async function registryEndpoint(): Promise<string> {
  if (env.inCluster) return registryHost()
  const { host, port } = await resolvePortForward(REGISTRY_FORWARD_KEY, {
    namespace: REGISTRY_NAMESPACE,
    target: `deploy/${REGISTRY_SERVICE_NAME}`,
    remotePort: REGISTRY_SERVICE_PORT,
  })
  return `${host}:${port}`
}

/** Drop the registry forward so the next call re-establishes it (after
 *  the registry pod is replaced). */
export function invalidateRegistryEndpoint(): void {
  invalidatePortForward(REGISTRY_FORWARD_KEY)
}

/** Whether the registry answers `/v2/` from here. A transport failure
 *  also drops the forward so the next call retries fresh. */
export async function registryReachable(): Promise<boolean> {
  let endpoint: string
  try {
    endpoint = await registryEndpoint()
  } catch {
    return false
  }
  try {
    const res = await fetch(`http://${endpoint}/v2/`, { signal: AbortSignal.timeout(3000) })
    return res.ok || res.status === 401
  } catch {
    invalidateRegistryEndpoint()
    return false
  }
}

/**
 * Whether the registry holds `repo:tag`: `present`, `absent` (a 404), or
 * `unknown` (unreachable, timeout, other status). Tags are content hashes,
 * so `present` means the bytes are there. Callers acting on absence must
 * not treat `unknown` as absent.
 */
export async function registryTagState(tag: string): Promise<'present' | 'absent' | 'unknown'> {
  const idx = tag.lastIndexOf(':')
  if (idx < 0) return 'unknown'
  const repo = tag.slice(0, idx)
  const ref = tag.slice(idx + 1)
  let endpoint: string
  try {
    endpoint = await registryEndpoint()
  } catch {
    return 'unknown'
  }
  try {
    const res = await fetch(`http://${endpoint}/v2/${repo}/manifests/${ref}`, {
      method: 'HEAD',
      headers: {
        Accept: 'application/vnd.oci.image.manifest.v1+json'
          + ', application/vnd.oci.image.index.v1+json'
          + ', application/vnd.docker.distribution.manifest.v2+json',
      },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) return 'present'
    return res.status === 404 ? 'absent' : 'unknown'
  } catch {
    invalidateRegistryEndpoint()
    return 'unknown'
  }
}

/**
 * The error for a yaac-shipped image missing from the registry. These
 * images (base/tools/nestable, proxy, netd, upstream mirrors) are built by
 * `yaac cluster install`, not by the server, which only builds project and
 * user layers (docs/trust-split-builds.md). So a missing tag means a
 * missing install, never a build trigger. Under test the fix is a rerun of
 * test/global-setup.ts instead.
 */
export function missingPrebuiltImage(what: string, tag: string): Error {
  return new Error(
    `${what} image ${tag} is missing from the local registry. `
    + (testEnv.requirePrebuiltImages
      ? 'Restart the test run so the global setup can build it.'
      : 'Build and push it with `yaac cluster install`.'),
  )
}

/** The in-cluster ref of a yaac-shipped image, or `missingPrebuiltImage`. */
export async function prebuiltRef(what: string, tag: string): Promise<string> {
  if (await registryTagState(tag) === 'present') return registryRef(tag)
  throw missingPrebuiltImage(what, tag)
}
