import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileHash, contextHash, ensureImageByTag } from '@/lib/container/image-builder'
import { ensurePodmanSocket, getSocketPath } from '@/lib/container/runtime'
import { DOCKERFILES_DIR, PROXY_DIR } from '@/lib/project/paths'

const execFileAsync = promisify(execFile)

/**
 * Each test worker spawns its own proxy sidecar (unique network per
 * TEST_RUN_ID), and they're never removed by per-test afterEach hooks
 * (those only target session containers via `yaac.data-dir`). Each proxy
 * publishes host port 10255+, so after a few runs the 100-port search
 * window used by ProxyClient exhausts and subsequent runs fail with
 * "No available port found starting from 10255".
 *
 * Prune every container built from a `yaac-test-proxy:*` image — these
 * are unambiguously test artifacts, separate from the user's real
 * `yaac-proxy:*` sidecar.
 */
async function pruneTestProxyContainers(): Promise<void> {
  let stdout: string
  try {
    const result = await execFileAsync('podman', [
      'ps', '-a',
      '--filter', 'label=yaac.proxy=true',
      '--format', '{{.Names}}\t{{.Image}}',
    ])
    stdout = result.stdout
  } catch { return /* podman not ready — main setup will probe again */ }

  const names = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, image]) => image?.includes('yaac-test-proxy'))
    .map(([name]) => name)
    .filter((name): name is string => !!name)

  if (names.length === 0) return
  // Remove one at a time: a bulk `podman rm` aborts on the first bad
  // entry, and podman's container store sometimes holds orphan refs to
  // deleted storage layers ("container not known") that fail rm even
  // with --ignore. Isolate those so healthy containers still get cleaned.
  await Promise.all(names.map((name) =>
    execFileAsync('podman', ['rm', '-f', '--ignore', name])
      .catch(() => {}),
  ))
}

/**
 * Pre-build all container images used by e2e tests.
 *
 * Each image is tagged with a content hash of its source files
 * (e.g. yaac-test-base:<hash>). This means the tag itself encodes
 * whether the image is up to date — no label inspection needed.
 * Test code computes the same hash to derive the expected tag.
 */
export async function setup(): Promise<void> {
  // Skip when podman is unavailable — tests that need it will fail on their own.
  // On Linux, revive a crashed socket from a previous run before probing, since
  // nothing else supervises `podman system service` in rootless containers.
  let podmanAvailable = false
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    podmanAvailable = true
  } catch {
    const socketPath = getSocketPath()
    if (socketPath) {
      try {
        await ensurePodmanSocket(socketPath, { timeoutMs: 5_000 })
        await execFileAsync('podman', ['info', '--format', 'json'])
        podmanAvailable = true
      } catch { /* not installed or revive failed */ }
    }
  }
  if (!podmanAvailable) return

  // Reclaim host ports held by leaked test proxies from prior runs before
  // any test tries to find an available port in the 10255+ range.
  await pruneTestProxyContainers()

  // Reassign podman lock IDs to prevent deadlocks caused by stale state
  // from previous test runs (containers removed but locks not reclaimed).
  try {
    await execFileAsync('podman', ['system', 'renumber'])
  } catch {
    // best-effort — may fail if containers are still running
  }

  // --- Base image (Dockerfile.default) ---
  const baseDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseHash = await fileHash(baseDockerfile)
  const baseTag = `yaac-test-base:${baseHash}`
  await ensureImageByTag(baseTag, baseDockerfile, DOCKERFILES_DIR)

  // --- Nestable layer (Dockerfile.nestable, layered on base) ---
  const nestDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
  const nestContentHash = await fileHash(nestDockerfile)
  const nestHash = crypto.createHash('sha256').update(`${baseHash}:${nestContentHash}`).digest('hex').slice(0, 16)
  const nestTag = `yaac-test-base-nestable:${nestHash}`
  await ensureImageByTag(nestTag, nestDockerfile, DOCKERFILES_DIR, { BASE_IMAGE: baseTag })

  // --- Proxy sidecar (podman/proxy-sidecar/) ---
  const proxyHash = await contextHash(PROXY_DIR)
  const proxyTag = `yaac-test-proxy:${proxyHash}`
  await ensureImageByTag(proxyTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR)
}

export async function teardown(): Promise<void> {
  await pruneTestProxyContainers()
}
