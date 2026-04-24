import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileHash, contextHash, ensureImageByTag } from '@/lib/container/image-builder'
import { ensurePodmanSocket, getSocketPath } from '@/lib/container/runtime'
import { DOCKERFILES_DIR, PROXY_DIR } from '@/lib/project/paths'

const execFileAsync = promisify(execFile)

/**
 * Prune every container built from a `yaac-test-*` image. Covers proxy
 * sidecars (yaac-test-proxy:*), mock remotes / test session containers
 * (yaac-test-base:*, yaac-test-base-nestable:*), and anything else the
 * suite tags under the `yaac-test-` prefix.
 *
 * Why an image-prefix filter rather than a label filter: an interrupted
 * test run leaves behind orphan containers whose conmons have died
 * (`conmon exited prematurely — internal libpod error`). Those orphans
 * accumulate across runs, drag down the shared podman service, and
 * eventually trigger the socket cascade. A label filter misses any
 * container whose create-time label we haven't explicitly set; the
 * image prefix catches every test artifact unambiguously.
 *
 * Safe by construction: production images use the `yaac-` prefix
 * without `-test-` (e.g. yaac-base, yaac-proxy, yaac-user-<slug>), so
 * a running real daemon's containers are never matched. See
 * `src/lib/container/image-builder.ts` — the test suite opts into
 * `imagePrefix: 'yaac-test'` to get this namespace separation.
 */
async function pruneTestContainers(): Promise<void> {
  let stdout: string
  try {
    const result = await execFileAsync('podman', [
      'ps', '-a', '--format', '{{.Names}}\t{{.Image}}',
    ])
    stdout = result.stdout
  } catch { return /* podman not ready — main setup will probe again */ }

  const names = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, image]) => image?.includes('yaac-test-'))
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

  // Wipe leaked test containers from prior runs. Reclaims the 10255+ host
  // ports held by leaked proxies, and flushes orphan mock/session
  // containers whose conmons died — those orphans hang the podman
  // service under subsequent test load.
  await pruneTestContainers()

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
  await pruneTestContainers()
}
