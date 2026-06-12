import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import crypto from 'node:crypto'
import { baseImageHash, fileHash, contextHash, ensureImageByTag, sessionUid } from '@/lib/container/image-builder'
import { ensurePodmanSocket, getSocketPath } from '@/lib/container/runtime'
import { pushImageToRegistry, registryReachable } from '@/lib/k8s/registry'
import { DOCKERFILES_DIR, PROXY_DIR, REDIRECT_INIT_DIR, RELAY_DIR } from '@/lib/project/paths'

const execFileAsync = promisify(execFile)

/**
 * Prune every podman container built from a `yaac-test-*` image. Sessions
 * run as kubernetes Jobs now, so this only catches leftovers in the build
 * engine's store: stray containers from interrupted older runs and any
 * helper containers a test spun up under podman.
 *
 * Why an image-prefix filter rather than a label filter: orphan containers
 * whose conmons have died (`conmon exited prematurely — internal libpod
 * error`) accumulate across runs, drag down the shared podman service,
 * and eventually trigger the socket cascade. A label filter misses any
 * container whose create-time label we haven't explicitly set; the
 * image prefix catches every test artifact unambiguously.
 *
 * Safe by construction: production images use the `yaac-` prefix
 * without `-test-` (e.g. yaac-base, yaac-proxy, yaac-user-<slug>), so
 * a running real daemon's artifacts are never matched, and the
 * `yaac-registry` container (registry:2 image) is untouched. See
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
 * Delete leaked per-run test namespaces (`yaac-test-<runId>`) from prior
 * interrupted runs. Cheap best-effort sweep — every error (kubectl
 * missing, cluster unreachable) is swallowed.
 */
async function cleanupLeakedTestNamespaces(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      'kubectl', ['get', 'namespaces', '-o', 'name'], { timeout: 10_000 },
    )
    const leaked = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith('namespace/yaac-test-'))
    if (leaked.length === 0) return
    await execFileAsync(
      'kubectl', ['delete', ...leaked, '--ignore-not-found', '--wait=false'],
      { timeout: 30_000 },
    )
  } catch { /* kubectl or cluster absent — nothing to sweep */ }
}

/**
 * Pre-build all container images used by e2e tests, and push them to the
 * local OCI registry so cluster pods can pull them.
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

  // Wipe leaked build-engine containers from prior runs — orphans whose
  // conmons died hang the podman service under subsequent build load.
  await pruneTestContainers()

  // --- Base image (Dockerfile.default) ---
  // Hash composition must match resolveImageChain: the YAAC_UID build arg
  // (in-container yaac uid = daemon uid, for idmapped hostPath writes) is
  // part of the image content, so it is folded into the tag.
  const baseDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseHash = await baseImageHash(baseDockerfile)
  const baseTag = `yaac-test-base:${baseHash}`
  await ensureImageByTag(baseTag, baseDockerfile, DOCKERFILES_DIR, { YAAC_UID: String(sessionUid()) })

  // --- Tools layer (Dockerfile.tools, layered on base) ---
  const toolsDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.tools')
  const toolsContentHash = await fileHash(toolsDockerfile)
  const toolsHash = crypto.createHash('sha256').update(`${baseHash}:${toolsContentHash}`).digest('hex').slice(0, 16)
  const toolsTag = `yaac-test-tools:${toolsHash}`
  await ensureImageByTag(toolsTag, toolsDockerfile, DOCKERFILES_DIR, { BASE_IMAGE: baseTag })

  // --- Nestable layer (Dockerfile.nestable, layered on tools) ---
  // In-pod rootless podman for nestedContainers e2e tests. Hash composition
  // must match resolveImageChain (tools hash + nestable content).
  const nestableDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
  const nestableContentHash = await fileHash(nestableDockerfile)
  const nestableHash = crypto.createHash('sha256').update(`${toolsHash}:${nestableContentHash}`).digest('hex').slice(0, 16)
  const nestableTag = `yaac-test-nestable:${nestableHash}`
  await ensureImageByTag(nestableTag, nestableDockerfile, DOCKERFILES_DIR, {
    BASE_IMAGE: toolsTag,
    YAAC_UID: String(sessionUid()),
  })

  // --- Proxy (k8s/proxy/) ---
  const proxyHash = await contextHash(PROXY_DIR)
  const proxyTag = `yaac-test-proxy:${proxyHash}`
  await ensureImageByTag(proxyTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR)

  // --- Transparent-egress redirect init container (k8s/redirect-init/) ---
  const redirectInitHash = await contextHash(REDIRECT_INIT_DIR)
  const redirectInitTag = `yaac-test-redirect-init:${redirectInitHash}`
  await ensureImageByTag(redirectInitTag, path.join(REDIRECT_INIT_DIR, 'Dockerfile'), REDIRECT_INIT_DIR)

  // --- Per-pod egress relay (k8s/relay/, multi-stage Go build) ---
  const relayHash = await contextHash(RELAY_DIR)
  const relayTag = `yaac-test-relay:${relayHash}`
  await ensureImageByTag(relayTag, path.join(RELAY_DIR, 'Dockerfile'), RELAY_DIR)

  // Session/mock pods pull images from the local registry, not the podman
  // store — push everything up front so test workers never race a push.
  // pushImageToRegistry no-ops when the content-hash tag is already there.
  if (await registryReachable()) {
    for (const tag of [baseTag, toolsTag, nestableTag, proxyTag, redirectInitTag, relayTag]) {
      await pushImageToRegistry(tag)
    }
  } else {
    console.log('[global-setup] local registry not reachable — e2e tests requiring a cluster will fail')
  }
}

export async function teardown(): Promise<void> {
  await pruneTestContainers()
  await cleanupLeakedTestNamespaces()
}
