import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { contextHash, ensureImageByTag, resolveTrustedLayers } from '@yaac/server/drivers/k8s/image-engine/image-builder'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import {
  TRUSTED_PARENT_COMPRESSION,
  mirrorPinnedUpstreams,
} from '@yaac/server/drivers/k8s/install/builtin-images'
import { pushImageToRegistry, registryReachable } from '@yaac/server/drivers/k8s/container/registry'
import { NETD_DIR, PROXY_DIR } from '@yaac/shared/project-paths'
import { TEST_CLI_DIR } from '@yaac/test-utils/cli-bundle'
import { buildTestServerImage, testServerImageTag } from '@yaac/test-utils/deployed-server'
import { testContainerOwnerLabel } from '@yaac/test-utils/setup'
import { gcTestImages } from '@yaac/test-utils/test-images'

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
  // conditional — it is the one slow step, and no suite reads it.
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
 * Remove every podman container this rig's suites left on the host engine.
 * Worktrees run as kubernetes Jobs, so the only such containers are helpers
 * a test ran under podman directly (nested-containers' mock upstream
 * registry) — leaked when a run is interrupted before its afterAll.
 *
 * Selected by the owner label (`testContainerOwnerLabel`), never by image
 * or name prefix: test rigs share one host engine, and a prefix sweep at
 * one rig's setup or teardown would remove a container the other rig's run
 * is using right then.
 */
async function pruneTestContainers(): Promise<void> {
  let stdout: string
  try {
    const result = await execFileAsync('podman', [
      'ps', '-a', '--filter', `label=${testContainerOwnerLabel()}`, '--format', '{{.Names}}',
    ])
    stdout = result.stdout
  } catch { return /* podman not ready — main setup will probe again */ }

  const names = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
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
  // netd's and the test server's ClusterRole/Binding, and the PVs behind
  // each file's storage claims, are cluster-scoped, so deleting the
  // namespace above leaves them behind. Filter on the owning install
  // namespace — a bare `app=yaac-netd` selector would also match the REAL
  // install's objects and break the developer's own cluster.
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'clusterrole,clusterrolebinding,pv', '-l', 'app in (yaac-netd,yaac-server)',
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

  // --- The trusted chain: base (Dockerfile.default) → tools
  // (Dockerfile.tools) → nestable (Dockerfile.nestable) ---
  // Resolved by the same helper the server's chain resolution and `yaac
  // cluster install` use, under the suite's own `yaac-test` prefix, so the
  // tags here ARE the tags a test worker looks up — hash composition
  // cannot drift between the two.
  const { base, tools, nestable } = await resolveTrustedLayers('yaac-test')
  for (const layer of [base, tools, nestable]) {
    await ensureImageByTag(layer.tag, layer.dockerfile, layer.context, layer.buildArgs)
  }

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
    // The trusted chain goes up zstd-compressed: these are the blobs a
    // sandboxed builder pod pulls as its parent, and zstd is measurably
    // faster there (see TRUSTED_PARENT_COMPRESSION).
    for (const tag of [base.tag, tools.tag, nestable.tag]) {
      await pushImageToRegistry(tag, { compressionFormat: TRUSTED_PARENT_COMPRESSION })
    }
    for (const tag of [proxyTag, netdTag]) {
      await pushImageToRegistry(tag)
    }
    // The digest-pinned upstreams every install mirrors: registry:2 for
    // the per-project registries, netd's Envoy, the builder pods' podman,
    // the gVisor installer's curl, and the npm cache's Verdaccio.
    // Pull-or-skip, then push. The installer's curl is unused by any e2e
    // today — mirrored so a test that does exercise the installer fails on
    // what it is testing, not a missing image.
    await mirrorPinnedUpstreams()
    // --- The dev server (dist-test/) --- the k8s tiers no longer spawn a
    // host server: their server is a Deployment, exactly as an install's is
    // (docs/server-in-cluster.md), so its image is a prebuilt like every
    // other. Built from the frozen CLI bundle above, so the image a worker
    // deploys is the same bundle its `runYaac` calls run.
    await buildTestServerImage()
  } else {
    console.log('[global-setup] local registry not reachable — e2e tests requiring a cluster will fail')
  }

  // Reclaim superseded test-image generations. Last, so this run's own
  // images have already been pushed, and they are passed as a keep set
  // since on an older checkout they are not the newest built. Skipped
  // where several test rigs share this engine: there the host runs
  // `pnpm gc:test-images` while every rig is idle (see gcTestImages).
  if (process.env.YAAC_TEST_SHARED_ENGINE !== '1') {
    const ownTags = [base.tag, tools.tag, nestable.tag, proxyTag, netdTag, await testServerImageTag()]
    const retired = await gcTestImages(ownTags).catch((err: unknown) => {
      console.log(`[global-setup] could not sweep stale test images: ${String(err)}`)
      return []
    })
    if (retired.length > 0) console.log(`[global-setup] retired ${retired.length} stale test image tag(s)`)
  }
}

export async function teardown(): Promise<void> {
  await pruneTestContainers()
  await cleanupLeakedTestNamespaces()
}
