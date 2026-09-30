import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import { invalidatePortForward, resolvePortForward } from '#drivers/k8s/substrate'
import { runTrackedPodman } from './host-procs'
import { registryAuthFile } from './registry-grant'
import { usesRootfulPodman } from './runtime'

/**
 * Client for the main OCI registry (the workload is in `#drivers/k8s/cluster`,
 * main-registry.ts). It has three addresses:
 *
 *  - `registryHost()`: the cluster address, the only one in image refs.
 *    Pods and node containerd use it.
 *  - `registryEndpoint()`: where this process reaches it. The Service
 *    directly when in-cluster, else a `kubectl port-forward`.
 *  - `podmanRegistryEndpoint()`: where podman reaches it. The same on Linux;
 *    on macOS podman runs in a VM, which reaches the host's port-forward via
 *    the gvproxy alias.
 *
 * The registry stores by repository path, so a push to any endpoint and a
 * pull by the cluster ref see the same bytes.
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

/** The host's loopback as seen from inside the podman machine VM
 *  (provided by gvproxy). */
const PODMAN_VM_HOST_ALIAS = 'host.containers.internal'

/**
 * The host:port in image refs: a full `.svc.cluster.local` name, which the
 * proxy's DNS forwards to CoreDNS. Node containerd matches it against the
 * hosts.toml `#drivers/k8s/cluster` writes instead of resolving it.
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
  const { host, port } = await registryForward()
  return `${host}:${port}`
}

/** Establish or reuse this process's one forward to the registry. */
async function registryForward(): Promise<{ host: string; port: number }> {
  return resolvePortForward(REGISTRY_FORWARD_KEY, {
    namespace: REGISTRY_NAMESPACE,
    target: `deploy/${REGISTRY_SERVICE_NAME}`,
    remotePort: REGISTRY_SERVICE_PORT,
  })
}

/** Where podman reaches the registry: the forward's address on Linux, the
 *  gvproxy host alias with the same port under podman machine. */
async function podmanRegistryEndpoint(): Promise<string> {
  const { host, port } = await registryForward()
  if (usesRootfulPodman()) return `${host}:${port}`
  return `${PODMAN_VM_HOST_ALIAS}:${port}`
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
 * Whether the registry holds `repo:tag` (tags are content hashes, so a hit
 * means the bytes are there). An unreachable registry reads as absent, so
 * the following push fails loudly.
 */
export async function registryHasTag(tag: string): Promise<boolean> {
  return await registryTagState(tag) === 'present'
}

/**
 * `present`, `absent` (a 404), or `unknown` (unreachable, timeout, other
 * status). For callers acting on absence, where `registryHasTag` would read
 * an unreachable registry as absent.
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
 * Push a locally built image (unless its tag is already present) and return
 * its in-cluster ref. Pushes to `podmanRegistryEndpoint()`, since podman may
 * run in a VM. Plain HTTP, so `--tls-verify=false`.
 *
 * Only trusted writers call this (install, e2e setup, `cluster check`), so
 * it uses a one-hour admin grant in a private temp authfile.
 *
 * `zstd` compression speeds up builder pods' parent pulls
 * (docs/trust-split-builds.md); node containerd handles it too.
 */
export async function pushImageToRegistry(
  localTag: string,
  opts: {
    onLog?: (line: string) => void
    compressionFormat?: 'zstd' | 'gzip'
  } = {},
): Promise<string> {
  const ref = registryRef(localTag)
  if (await registryHasTag(localTag)) return ref

  const engineEndpoint = await podmanRegistryEndpoint()
  const target = `${engineEndpoint}/${localTag}`
  const compressionArgs = opts.compressionFormat
    ? ['--compression-format', opts.compressionFormat]
    : []
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-push-auth-'))
  const authFile = path.join(authDir, 'auth.json')
  try {
    await fs.writeFile(authFile, await registryAuthFile(engineEndpoint, '*', 3600), { mode: 0o600 })
    serverLog(`[registry] pushing ${localTag} -> ${ref}`)
    // Tracked like builds, since an orphaned push holds the store lock.
    await runTrackedPodman([
      'push', '--tls-verify=false', '--authfile', authFile, ...compressionArgs, localTag, target,
    ], {
      tag: localTag,
      logPrefix: `[push ${localTag}] `,
      onLog: opts.onLog,
      timeoutMs: 600_000,
    })
  } finally {
    await fs.rm(authDir, { recursive: true, force: true })
  }
  return ref
}
