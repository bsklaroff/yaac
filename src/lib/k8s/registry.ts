import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { daemonLog, pipeToDaemonLog } from '@/daemon/log'

const execFileAsync = promisify(execFile)

/**
 * Host:port of the local OCI registry that bridges host-side `podman
 * build` and in-cluster image pulls. The same string is used as the push
 * target from the host (the registry publishes 127.0.0.1:5000) and as the
 * image-ref prefix in pod specs (kind's local-registry containerd config
 * resolves `localhost:5000` from inside the node).
 */
export function registryHost(): string {
  return process.env.YAAC_K8S_REGISTRY ?? 'localhost:5000'
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
 * `localhost:5000` to this registry (kind: containerd `config_path` +
 * hosts.toml + connecting the container to the kind network). That wiring
 * is cluster setup, documented in the README and verified by
 * `yaac cluster check` — yaac does not mutate cluster nodes itself.
 */
export async function ensureLocalRegistry(): Promise<void> {
  if (await registryReachable()) return

  const port = registryHost().split(':')[1] ?? '5000'
  daemonLog(`[registry] starting ${REGISTRY_CONTAINER_NAME} on 127.0.0.1:${port}`)
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
 * Push a locally built image to the registry and return its in-cluster
 * ref. No-ops (returning the ref) when the content-hash tag is already
 * present. `--tls-verify=false` because the local registry is plain HTTP
 * on loopback.
 */
export async function pushImageToRegistry(localTag: string): Promise<string> {
  const ref = registryRef(localTag)
  if (await registryHasTag(localTag)) return ref

  daemonLog(`[registry] pushing ${localTag} -> ${ref}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', ['push', '--tls-verify=false', localTag, ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    })
    const prefix = `[push ${localTag}] `
    pipeToDaemonLog(child.stdout, prefix)
    pipeToDaemonLog(child.stderr, prefix)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`podman push exited with code ${code}`))
    })
    child.on('error', reject)
  })
  return ref
}
