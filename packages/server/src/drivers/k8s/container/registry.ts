import { serverLog } from '#log'
import { invalidatePortForward, resolvePortForward } from '#drivers/k8s/substrate'
import { runTrackedPodman } from './host-procs'
import { usesRootfulPodman } from './runtime'

/**
 * The CLIENT half of the main OCI registry — the one image bus between
 * host-side `podman build`, the sandboxed builder pods, and every node
 * pulling a worktree image. The registry itself is an in-cluster
 * Deployment + Service stood up by `#drivers/k8s/cluster` (main-registry.ts);
 * nothing here creates or owns it.
 *
 * THREE addresses, and keeping them apart is the whole point of this module:
 *
 *  - `registryHost()` is the CLUSTER address, and the only one that ever
 *    appears in an image ref. Pods and node containerd resolve it; the
 *    server never dials it.
 *  - `registryEndpoint()` is where THIS PROCESS reaches the same registry:
 *    a long-lived `kubectl port-forward` (the same mechanism the stream
 *    relay uses), which assumes nothing about host↔pod networking beyond
 *    the apiserver access every other call already needs.
 *  - `podmanRegistryEndpoint()` is where the PODMAN ENGINE reaches it. On
 *    Linux that is the same loopback the server uses, because podman runs in
 *    this process's network namespace. On macOS it is NOT: podman runs inside
 *    the machine VM, where `127.0.0.1` is the VM's own loopback and the
 *    forward — a listener on the HOST — is unreachable. Only the port is
 *    shared; the host is the gvproxy alias.
 *
 * Blob storage is addressed by repository path alone, so pushing through
 * the forwarded port and pulling by the cluster ref name the same bytes.
 * Content-hash tags stay immutable, `registryHasTag()` stays the server-side
 * push skip, and pods keep `imagePullPolicy: IfNotPresent`.
 *
 * The split matters because the two endpoints fail differently: a wrong
 * `registryEndpoint()` fails the server's own HEAD, while a wrong
 * `podmanRegistryEndpoint()` fails only inside podman — every blob retried
 * three times against a refused port, a push that never lands, and a
 * `registryHasTag()` that therefore never skips it on the next sweep.
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
 * The host's loopback as seen from inside the podman machine VM, published by
 * gvproxy (the machine's user-mode network stack) and resolvable in the VM
 * without any per-machine setup. This is the ONE name that reaches a
 * host-side listener — notably a `kubectl port-forward` — from a `podman
 * push` running in the VM.
 */
const PODMAN_VM_HOST_ALIAS = 'host.containers.internal'

/**
 * Host:port that image refs are prefixed with — a cluster-DNS name, never
 * something only the host can resolve. A FULL `.svc.cluster.local` FQDN
 * for the same reason the per-project registries use one: worktrees resolve
 * it through the proxy's split-horizon DNS, which forwards only
 * `.cluster.local` to CoreDNS. Node containerd never resolves it at all —
 * it matches the string against the hosts.toml `#drivers/k8s/cluster` writes.
 */
export function registryHost(): string {
  return `${REGISTRY_SERVICE_NAME}.${REGISTRY_NAMESPACE}.svc.cluster.local:${REGISTRY_SERVICE_PORT}`
}

/** Full in-cluster image ref for a locally built `repo:tag`. */
export function registryRef(tag: string): string {
  return `${registryHost()}/${tag}`
}

/**
 * Where THIS process reaches the registry: the local end of a long-lived
 * port-forward into the registry Deployment, spawned on first use and
 * shared by every push and HEAD of this server run. Throws when the
 * forward cannot be established — which is what an absent registry
 * Deployment looks like from here.
 */
export async function registryEndpoint(): Promise<string> {
  const { host, port } = await registryForward()
  return `${host}:${port}`
}

/**
 * Establish (or reuse) this process's forward into the registry Deployment.
 * Both endpoint accessors go through here so they name the same forward
 * child, and so the VM-facing address can never drift onto a second forward
 * with a different port.
 */
async function registryForward(): Promise<{ host: string; port: number }> {
  return resolvePortForward(REGISTRY_FORWARD_KEY, {
    namespace: REGISTRY_NAMESPACE,
    target: `deploy/${REGISTRY_SERVICE_NAME}`,
    remotePort: REGISTRY_SERVICE_PORT,
  })
}

/**
 * Where the podman engine reaches the registry — the address that goes into
 * a `podman push` target, which is NOT always the one this process dials.
 *
 * On Linux podman shares this process's netns, so the two endpoints
 * coincide. Under podman machine they do not: the forward's listener
 * belongs to the host, so the VM has to come back out to it by name. The
 * forward's PORT still applies — it is a host port, and gvproxy maps the
 * alias to the host loopback it is bound on.
 */
async function podmanRegistryEndpoint(): Promise<string> {
  const { host, port } = await registryForward()
  if (usesRootfulPodman()) return `${host}:${port}`
  return `${PODMAN_VM_HOST_ALIAS}:${port}`
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
 * present: tags are content-addressed, so a tag the registry holds already
 * names these exact bytes. `--tls-verify=false` because the registry serves
 * plain HTTP.
 *
 * The push TARGET is the ENGINE-facing endpoint while the RETURNED ref is
 * the cluster one: the registry stores by repository path, so the bytes a
 * push puts at `<engine endpoint>/yaac-tools:abc` are exactly what a node
 * pulls as `yaac-registry.yaac.svc.cluster.local:5000/yaac-tools:abc`.
 * Note the target is `podmanRegistryEndpoint()`, not `registryEndpoint()` —
 * this runs podman, which on macOS is in the machine VM and cannot see the
 * host loopback the server itself HEADs through.
 *
 * `compressionFormat: 'zstd'` is used for trusted-layer pushes feeding
 * builder-pod parent pulls: zstd layers cut a pod's empty-graphroot parent
 * pull from 65.6s to 40.4s (measured, docs/trust-split-builds.md) at
 * no meaningful host-side push cost. Node containerd pulls of zstd blobs
 * (the worktree-pod path) are validated — see the plan doc.
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

  const target = `${await podmanRegistryEndpoint()}/${localTag}`
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
