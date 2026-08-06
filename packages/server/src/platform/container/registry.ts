import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import { invalidatePortForward, resolvePortForward } from '#platform/k8s'
import { runTrackedPodman } from './host-procs'

/**
 * The CLIENT half of the main OCI registry — the one image bus between
 * host-side `podman build`, the sandboxed builder pods, and every node
 * pulling a session image. The registry itself is an in-cluster
 * Deployment + Service stood up by `#features/cluster` (main-registry.ts);
 * nothing here creates or owns it.
 *
 * Two addresses, and keeping them apart is the whole point of this module:
 *
 *  - `registryHost()` is the CLUSTER address, and the only one that ever
 *    appears in an image ref. Pods and node containerd resolve it; the
 *    server never dials it.
 *  - `registryEndpoint()` is where THIS PROCESS reaches the same registry.
 *    Top-level that is a long-lived `kubectl port-forward` (the same
 *    mechanism the stream relay uses), which assumes nothing about host↔pod
 *    networking beyond the apiserver access every other call already needs.
 *    Nested, it is the outer per-project registry, which the inner server —
 *    itself a pod — dials directly.
 *
 * Blob storage is addressed by repository path alone, so pushing through
 * the forwarded loopback port and pulling by the cluster ref name the same
 * bytes. Content-hash tags stay immutable, `registryHasTag()` stays the
 * server-side push skip, and pods keep `imagePullPolicy: IfNotPresent`.
 */

/** Service (and Deployment) name of the in-cluster registry. */
export const REGISTRY_SERVICE_NAME = 'yaac-registry'

/**
 * In-cluster port. Deliberately not 443/80: netd redirects those to the
 * proxy, whereas 5000 rides straight to the registry un-MITM'd — the same
 * reason the per-project registries use it.
 */
export const REGISTRY_SERVICE_PORT = 5000

/**
 * Namespace holding the registry: the DEFAULT install namespace, NOT
 * `k8sNamespace()`. E2e runs isolate their objects in per-run namespaces
 * (`YAAC_K8S_NAMESPACE=yaac-test-<run-id>`) but must keep sharing ONE image
 * store — the prebuilt images `test/global-setup.ts` pushes once are pulled
 * by every run — which is exactly what the single podman container gave
 * them before. Pinning the namespace also keeps the registry's cluster ref
 * stable, so the node hosts.toml written for it never has to be rewritten
 * per run.
 */
export const REGISTRY_NAMESPACE = 'yaac'

/** Key for this process's registry port-forward child. */
const REGISTRY_FORWARD_KEY = 'main-registry'

/**
 * Host:port that image refs are prefixed with — a cluster-DNS name, never
 * something only the host can resolve. A FULL `.svc.cluster.local` FQDN
 * for the same reason the per-project registries use one: sessions resolve
 * it through the proxy's split-horizon DNS, which forwards only
 * `.cluster.local` to CoreDNS. Node containerd never resolves it at all —
 * it matches the string against the hosts.toml `#features/cluster` writes.
 *
 * `YAAC_K8S_REGISTRY` overrides it wholesale; a nested yaac is the one
 * production setter (the outer install's per-project registry).
 */
export function registryHost(): string {
  return env.k8sRegistry
    ?? `${REGISTRY_SERVICE_NAME}.${REGISTRY_NAMESPACE}.svc.cluster.local:${REGISTRY_SERVICE_PORT}`
}

/** Full in-cluster image ref for a locally built `repo:tag`. */
export function registryRef(tag: string): string {
  return `${registryHost()}/${tag}`
}

/**
 * Where THIS process reaches the registry. Externally-managed registries
 * (nested yaac) are dialed at their configured address; otherwise this is
 * the local end of a long-lived port-forward into the registry Deployment,
 * spawned on first use and shared by every push and HEAD of this server
 * run. Throws when the forward cannot be established — which is what an
 * absent registry Deployment looks like from here.
 */
export async function registryEndpoint(): Promise<string> {
  const external = env.k8sRegistry
  if (external) return external
  const { host, port } = await resolvePortForward(REGISTRY_FORWARD_KEY, {
    namespace: REGISTRY_NAMESPACE,
    target: `deploy/${REGISTRY_SERVICE_NAME}`,
    remotePort: REGISTRY_SERVICE_PORT,
  })
  return `${host}:${port}`
}

/**
 * Drop this process's registry forward so the next call re-establishes it.
 * Needed after anything that replaces the registry pod (a rollout), which
 * leaves the existing child forwarding into a pod that no longer exists.
 */
export function invalidateRegistryEndpoint(): void {
  invalidatePortForward(REGISTRY_FORWARD_KEY)
}

/**
 * True when the registry answers the OCI distribution ping from here. A
 * failed transport also invalidates the forward, so a dead port-forward
 * child heals on the next call rather than poisoning the whole server run.
 */
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
 * True when the registry already holds `repo:tag`. Content-hash tags are
 * immutable, so a tag hit means the exact image bytes are present and the
 * push can be skipped.
 *
 * Fails to `false`, deliberately: an unanswerable registry then reads as
 * "not present", so the caller pushes and fails loudly there instead of
 * silently skipping a push that never happened.
 */
export async function registryHasTag(tag: string): Promise<boolean> {
  const idx = tag.lastIndexOf(':')
  if (idx < 0) return false
  const repo = tag.slice(0, idx)
  const ref = tag.slice(idx + 1)
  let endpoint: string
  try {
    endpoint = await registryEndpoint()
  } catch {
    return false
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
    return res.ok
  } catch {
    invalidateRegistryEndpoint()
    return false
  }
}

/**
 * Push a locally built image to the registry and return its in-cluster
 * ref. No-ops (returning the ref) when the content-hash tag is already
 * present — except with `force`, for the one flow that changes bytes under
 * an unchanged tag (`yaac project rebuild`'s --no-cache tools refresh).
 * `--tls-verify=false` because the registry serves plain HTTP.
 *
 * The push TARGET is the process-local endpoint while the RETURNED ref is
 * the cluster one: the registry stores by repository path, so the bytes a
 * push puts at `127.0.0.1:<fwd>/yaac-tools:abc` are exactly what a node
 * pulls as `yaac-registry.yaac.svc.cluster.local:5000/yaac-tools:abc`.
 *
 * `compressionFormat: 'zstd'` is used for trusted-layer pushes feeding
 * builder-pod parent pulls: zstd layers cut a pod's empty-graphroot parent
 * pull from 65.6s to 40.4s (measured, docs/trust-split-builds.md) at
 * no meaningful host-side push cost. Node containerd pulls of zstd blobs
 * (the session-pod path) are validated — see the plan doc.
 */
export async function pushImageToRegistry(
  localTag: string,
  opts: {
    onLog?: (line: string) => void
    force?: boolean
    compressionFormat?: 'zstd' | 'gzip'
  } = {},
): Promise<string> {
  const ref = registryRef(localTag)
  if (!opts.force && await registryHasTag(localTag)) return ref

  const target = `${await registryEndpoint()}/${localTag}`
  const compressionArgs = opts.compressionFormat
    ? ['--compression-format', opts.compressionFormat]
    : []
  serverLog(`[registry] pushing ${localTag} -> ${ref}`)
  // Tracked like the builds: an orphaned push holds the image-store lock
  // against the next server's first build.
  await runTrackedPodman(['push', '--tls-verify=false', ...compressionArgs, localTag, target], {
    tag: localTag,
    logPrefix: `[push ${localTag}] `,
    onLog: opts.onLog,
    timeoutMs: 600_000,
  })
  return ref
}
