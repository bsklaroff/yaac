import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileAsync } from '#drivers/k8s/substrate'
import { registryAuthFile, registryEndpoint, registryRef, registryTagState } from '#drivers/k8s/cluster'
import { serverLog } from '#lib/log'
import { runTrackedPodman } from './host-procs'
import { usesRootfulPodman } from './podman'

/**
 * The host image store: what `yaac cluster install` (and the e2e global
 * setup) builds with podman and pushes to the main registry. The server
 * never builds here; it resolves images from the in-cluster registry
 * (docs/trust-split-builds.md).
 */

/** Whether an image exists in the local podman store. */
export async function imageExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('podman', ['image', 'inspect', name])
    return true
  } catch {
    return false
  }
}


/**
 * Host build timeouts. Ten minutes with no output means the build is stuck.
 * The one-hour total catches a stuck build that keeps printing (a retry
 * loop), which would otherwise hold the image-store lock and block every
 * host build behind it. Shorter than the builder pod's deadline because
 * host builds are only yaac's own Dockerfiles.
 */
const HOST_BUILD_IDLE_TIMEOUT_MS = 600_000
const HOST_BUILD_TOTAL_TIMEOUT_MS = 3600_000

/**
 * Run `podman build` via the CLI rather than podman's Docker-compat API:
 * the compat endpoint writes Docker v2 manifests and discards intermediate
 * layers, so it could not share the CLI's OCI layer cache. Tracked (see
 * `runTrackedPodman`) so a build orphaned by an interrupted install is not
 * duplicated by the next one.
 */
export async function buildImage(
  imageName: string,
  dockerfile: string,
  context: string,
  buildArgs?: Record<string, string>,
): Promise<void> {
  const args = ['build', '-t', imageName, '-f', dockerfile]
  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(context)

  await runTrackedPodman(args, {
    tag: imageName,
    logPrefix: `[build ${imageName}] `,
    idleTimeoutMs: HOST_BUILD_IDLE_TIMEOUT_MS,
    timeoutMs: HOST_BUILD_TOTAL_TIMEOUT_MS,
  })
}

/** Build an image unless its tag already exists. Used by the CLI install
 *  and the test global setup. */
export async function ensureImageByTag(tag: string, dockerfile: string, context: string, buildArgs?: Record<string, string>): Promise<void> {
  if (await imageExists(tag)) return
  serverLog(`[build] starting ${tag}`)
  await buildImage(tag, dockerfile, context, buildArgs)
}

/** The host's loopback as seen from inside the podman machine VM
 *  (provided by gvproxy). */
const PODMAN_VM_HOST_ALIAS = 'host.containers.internal'

/**
 * Where podman reaches the registry: this process's endpoint (the
 * port-forward) on Linux, the gvproxy host alias with the same port under
 * podman machine, whose engine runs in a VM.
 */
async function podmanRegistryEndpoint(): Promise<string> {
  const endpoint = await registryEndpoint()
  if (usesRootfulPodman()) return endpoint
  return `${PODMAN_VM_HOST_ALIAS}:${endpoint.slice(endpoint.lastIndexOf(':') + 1)}`
}

/**
 * Push a locally built image (unless its tag is already present) and return
 * its in-cluster ref. Plain HTTP, so `--tls-verify=false`.
 *
 * Only trusted writers call this (install, e2e setup, `cluster check`), so
 * it uses a one-hour admin grant in a private temp authfile.
 *
 * `zstd` compression speeds up builder pods' parent pulls
 * (docs/trust-split-builds.md); node containerd handles it too.
 */
export async function pushImageToRegistry(
  localTag: string,
  opts: { compressionFormat?: 'zstd' } = {},
): Promise<string> {
  const ref = registryRef(localTag)
  if (await registryTagState(localTag) === 'present') return ref

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
      timeoutMs: 600_000,
    })
  } finally {
    await fs.rm(authDir, { recursive: true, force: true })
  }
  return ref
}
