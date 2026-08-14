import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import crypto from 'node:crypto'
import { baseImageHash, fileHash, contextHash, toolsContentHash, ensureImageByTag } from '@yaac/server/drivers/k8s/image-engine/image-builder'
import { podUid } from '@yaac/server/drivers/k8s/substrate/pod-spec'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import { ensureRegistryImage } from '@yaac/server/drivers/k8s/cluster/project-registry'
import { ensureBuilderImage } from '@yaac/server/drivers/k8s/images/builder-pod'
import { ensureEnvoyImage } from '@yaac/server/drivers/k8s/cluster/netd'
import { ensureGvisorInstallerImage } from '@yaac/server/drivers/k8s/cluster/gvisor-installer'
import { pushImageToRegistry, registryReachable } from '@yaac/server/drivers/k8s/container/registry'
import { DOCKERFILES_DIR, NETD_DIR, PROXY_DIR } from '@yaac/shared/project-paths'
import { TEST_CLI_DIR } from '@yaac/test-utils/cli'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Build the CLI the suites spawn, then hand them their own copy of it
 * (TEST_CLI_DIR — see packages/test-utils/src/cli.ts). They run the built
 * bundle rather than the source under tsx because a fresh process pays tsx's
 * transpile every time — seconds per spawn, minutes per run — so it has to
 * exist and be current before any worker starts. Building here,
 * unconditionally, is what makes "the suite tested a stale bundle"
 * unrepresentable: an incremental tsup pass is ~200ms, the asset copies a
 * few seconds.
 *
 * Assets, not just cli.js: the bundle runs in bundled mode (tsup sets
 * YAAC_BUNDLED), where PACKAGE_ROOT is the directory holding cli.js — so the
 * migrations, k8s manifests, builtin skills and worktree-bin scripts must be
 * sitting beside it or a spawned server dies on its first query.
 */
async function buildCliBundle(): Promise<void> {
  // build:assets copies packages/frontend/dist rather than building it, so a
  // tree that has never built the SPA needs that first. Only the frontend is
  // conditional — it is the one slow step, and nothing but `yaac open` reads it.
  if (!await fileExists(path.join(REPO_ROOT, 'packages', 'frontend', 'dist', 'index.html'))) {
    await execFileAsync('pnpm', ['build:frontend'], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }
  for (const script of ['build:cli', 'build:assets', 'build:id']) {
    await execFileAsync('pnpm', [script], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }

  // Snapshot it out of dist/ before the workers start. `pnpm watch` builds
  // into dist/ on every save with `clean: true`, so a save landing mid-run
  // would delete the binary the suites are spawning; from here on they read
  // only this copy. Replaced wholesale rather than merged so a rename or a
  // deletion in dist/ can't leave a stale file behind to be spawned.
  await fs.rm(TEST_CLI_DIR, { recursive: true, force: true })
  await fs.cp(path.join(REPO_ROOT, 'dist'), TEST_CLI_DIR, { recursive: true })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

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
 * a running real server's artifacts are never matched, and the
 * `yaac-registry` container (registry:2 image) is untouched. See
 * `src/drivers/k8s/image-engine/image-builder.ts` — the test suite opts into
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
 * interrupted runs, and the cluster-scoped RBAC each run's netd owns
 * (ClusterRole/Binding names are global, so they do not cascade with the
 * namespace). Cheap best-effort sweep — every error (kubectl missing,
 * cluster unreachable) is swallowed.
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
    if (leaked.length > 0) {
      await execFileAsync(
        'kubectl', ['delete', ...leaked, '--ignore-not-found', '--wait=false'],
        { timeout: 30_000 },
      )
    }
  } catch { /* kubectl or cluster absent — nothing to sweep */ }
  // netd's ClusterRole/Binding are cluster-scoped, so deleting the
  // namespace above leaves them behind. Filter on the owning install
  // namespace — a bare `app=yaac-netd` selector would also match the REAL
  // install's RBAC and break the developer's own cluster.
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'clusterrole,clusterrolebinding', '-l', 'app=yaac-netd',
      '-o', "jsonpath={range .items[*]}{.kind}/{.metadata.name}{'\\t'}{.metadata.labels.yaac\\.install-namespace}{'\\n'}{end}",
    ], { timeout: 10_000 })
    const leaked = stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([, ns]) => ns?.startsWith('yaac-test-'))
      .map(([ref]) => ref.toLowerCase())
    if (leaked.length > 0) {
      await execFileAsync(
        'kubectl', ['delete', ...leaked, '--ignore-not-found', '--wait=false'],
        { timeout: 30_000 },
      )
    }
  } catch { /* cluster unreachable — nothing to sweep */ }
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
  // Before anything else, and before the podman gate below: every suite that
  // loads @yaac/test-utils/cli spawns dist/cli.js, podman or no podman.
  await buildCliBundle()

  // Skip when podman is unavailable — tests that need it will fail on their own.
  // Build images on the same rootful engine the cluster pulls from — otherwise
  // they land in a rootless store the kind node can't see.
  ensureRootfulPodmanHost()
  let podmanAvailable = false
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    podmanAvailable = true
  } catch { /* not installed or not running — tests that need it will fail */ }
  if (!podmanAvailable) return

  // Wipe leaked build-engine containers from prior runs — orphans whose
  // conmons died hang the podman service under subsequent build load.
  await pruneTestContainers()

  // --- Base image (Dockerfile.default) ---
  // Hash composition must match resolveImageChain: the YAAC_UID build arg
  // (in-container yaac uid = server uid, for idmapped hostPath writes) is
  // part of the image content, so it is folded into the tag.
  const baseDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseHash = await baseImageHash(baseDockerfile)
  const baseTag = `yaac-test-base:${baseHash}`
  await ensureImageByTag(baseTag, baseDockerfile, DOCKERFILES_DIR, { YAAC_UID: String(podUid()) })

  // --- Tools layer (Dockerfile.tools, layered on base) ---
  // toolsContentHash covers the Dockerfile plus its COPY'd support files
  // (the generated opencode models.dev catalog) — same helper as
  // resolveImageChain so the two derive identical tags.
  const toolsDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.tools')
  const toolsHash = crypto.createHash('sha256').update(`${baseHash}:${await toolsContentHash()}`).digest('hex').slice(0, 16)
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
    YAAC_UID: String(podUid()),
  })

  // --- Proxy (k8s/proxy/) ---
  const proxyHash = await contextHash(PROXY_DIR)
  const proxyTag = `yaac-test-proxy:${proxyHash}`
  await ensureImageByTag(proxyTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR)

  // --- netd (k8s/netd/) --- the per-node egress redirect daemon. Built
  // here like the proxy so no test worker races a build; its Envoy
  // sidecar is a digest-pinned mirror, handled below.
  const netdHash = await contextHash(NETD_DIR)
  const netdTag = `yaac-test-netd:${netdHash}`
  await ensureImageByTag(netdTag, path.join(NETD_DIR, 'Dockerfile'), NETD_DIR)

  // Session/mock pods pull images from the local registry, not the podman
  // store — push everything up front so test workers never race a push.
  // pushImageToRegistry no-ops when the content-hash tag is already there.
  if (await registryReachable()) {
    for (const tag of [baseTag, toolsTag, nestableTag, proxyTag, netdTag]) {
      await pushImageToRegistry(tag)
    }
    // Per-project registry image (registry:2, digest-pinned mirror) and
    // the sandboxed builder pods' podman image — pull-or-skip, then push,
    // same as above.
    await ensureRegistryImage(false)
    await ensureBuilderImage(false)
    await ensureEnvoyImage(false)
    // The gVisor installer's image (digest-pinned upstream curl). No e2e
    // runs `cluster setup`, so nothing here needs it today — mirrored so a
    // test that does exercise the installer fails on what it is testing
    // rather than on a missing image.
    await ensureGvisorInstallerImage(false)
  } else {
    console.log('[global-setup] local registry not reachable — e2e tests requiring a cluster will fail')
  }
}

export async function teardown(): Promise<void> {
  await pruneTestContainers()
  await cleanupLeakedTestNamespaces()
}
