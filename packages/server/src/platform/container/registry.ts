import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { serverLog, pipeToServerLog } from '#log'
import { env } from '@yaac/shared/env'

const execFileAsync = promisify(execFile)

/**
 * Host:port of the local OCI registry that bridges host-side `podman
 * build` and in-cluster image pulls. The same string is used as the push
 * target from the host (the registry publishes 127.0.0.1:5001) and as the
 * image-ref prefix in pod specs (kind's local-registry containerd config
 * resolves `localhost:5001` from inside the node).
 *
 * Host port 5001, not 5000: macOS's AirPlay Receiver binds `::1:5000` and
 * answers 403, so a `localhost:5000` fetch resolving to IPv6 first hits
 * AirPlay instead of the registry. On 5001 the IPv6 attempt simply
 * refuses and the client falls through to the IPv4 registry. The
 * container-internal port stays 5000 (the `yaac-registry:5000` the kind
 * node reaches over the podman network).
 */
export function registryHost(): string {
  return env.k8sRegistry
}

/** Full in-cluster image ref for a locally built `repo:tag`. */
export function registryRef(tag: string): string {
  return `${registryHost()}/${tag}`
}

/** Name of the registry container yaac manages when none is running. */
export const REGISTRY_CONTAINER_NAME = 'yaac-registry'

/**
 * True when the registry answers the OCI distribution ping. Any registry
 * on the configured address counts (e.g. one created by kind's
 * local-registry setup script) — yaac only creates its own when nothing
 * is listening.
 */
export async function registryReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://${registryHost()}/v2/`, { signal: AbortSignal.timeout(3000) })
    return res.ok || res.status === 401
  } catch {
    return false
  }
}

/**
 * True when the registry already holds `repo:tag`. Content-hash tags are
 * immutable, so a tag hit means the exact image bytes are present and the
 * push can be skipped.
 */
export async function registryHasTag(tag: string): Promise<boolean> {
  const idx = tag.lastIndexOf(':')
  if (idx < 0) return false
  const repo = tag.slice(0, idx)
  const ref = tag.slice(idx + 1)
  try {
    const res = await fetch(`http://${registryHost()}/v2/${repo}/manifests/${ref}`, {
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
    return false
  }
}

/**
 * Ensure a local registry container is serving on `registryHost()`.
 * Reuses anything already listening (kind's canonical local-registry
 * setup, a prior yaac run); otherwise starts `registry:2` under podman
 * publishing 127.0.0.1 only.
 *
 * NOTE: for pods to pull from it, the cluster must be wired to resolve
 * `localhost:5001` to this registry (kind: containerd `config_path` +
 * hosts.toml + connecting the container to the kind network). That wiring
 * is cluster setup, documented in the README and verified by
 * `yaac cluster check` — yaac does not mutate cluster nodes itself.
 */
export async function ensureLocalRegistry(): Promise<void> {
  if (await registryReachable()) return

  // Inside a nested yaac (YAAC_NESTED=1) the registry is the outer
  // per-project registry — external infrastructure the inner server must
  // never try to stand up its own replacement for.
  if (env.nested) {
    throw new Error(
      `Registry ${registryHost()} is not answering. It is externally managed `
      + '(nested yaac uses the outer per-project registry) — check the outer yaac.',
    )
  }

  const port = registryHost().split(':')[1] ?? '5001'
  serverLog(`[registry] starting ${REGISTRY_CONTAINER_NAME} on 127.0.0.1:${port}`)
  try {
    await execFileAsync('podman', ['rm', '-f', '--ignore', REGISTRY_CONTAINER_NAME])
    await execFileAsync('podman', [
      'run', '-d', '--name', REGISTRY_CONTAINER_NAME,
      '-p', `127.0.0.1:${port}:5000`,
      'docker.io/library/registry:2',
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to start local registry container: ${msg}`)
  }

  for (let i = 0; i < 20; i++) {
    if (await registryReachable()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Local registry did not become ready on ${registryHost()}`)
}

/**
 * Force-remove the yaac-managed local registry container. `--ignore` makes
 * a missing container a no-op (idempotent teardown), and force-removal
 * disconnects it from the kind network first. Only ever targets the
 * container yaac creates by name — a registry someone else runs on the same
 * address is left untouched. Used by `yaac cluster delete`; its cached image
 * layers are rebuildable, so losing them only costs re-pushes on next setup.
 */
export async function removeLocalRegistry(): Promise<void> {
  await execFileAsync('podman', ['rm', '-f', '--ignore', REGISTRY_CONTAINER_NAME])
}

/**
 * Push a locally built image to the registry and return its in-cluster
 * ref. No-ops (returning the ref) when the content-hash tag is already
 * present — except with `force`, for the one flow that changes bytes under
 * an unchanged tag (`yaac project rebuild`'s --no-cache tools refresh).
 * `--tls-verify=false` because the local registry is plain HTTP on
 * loopback.
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

  const compressionArgs = opts.compressionFormat
    ? ['--compression-format', opts.compressionFormat]
    : []
  serverLog(`[registry] pushing ${localTag} -> ${ref}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', ['push', '--tls-verify=false', ...compressionArgs, localTag, ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    })
    const prefix = `[push ${localTag}] `
    pipeToServerLog(child.stdout, prefix, opts.onLog)
    pipeToServerLog(child.stderr, prefix, opts.onLog)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`podman push exited with code ${code}`))
    })
    child.on('error', reject)
  })
  return ref
}
