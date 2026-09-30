import { execFile } from 'node:child_process'
import type { TestProject } from 'vitest/node'
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
import { requireKindByo } from '@yaac/test-utils/kind-byo'
import { testBackend } from '@yaac/test-utils/kind-byo-layout'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Build the CLI and copy it to TEST_CLI_DIR
 * (packages/test-utils/src/cli-bundle.ts) for the suites to spawn. A bundle
 * avoids paying the tsx transpile on every spawn, and building every run
 * (an incremental pass takes seconds) means the suites never test a stale
 * bundle.
 *
 * The assets are copied too: in bundled mode PACKAGE_ROOT is the directory
 * holding cli.js, so the migrations, k8s manifests, builtin skills and
 * workspace-bin scripts must sit beside it. The SPA is built only if it
 * never has been, since it is slow and no suite reads it.
 */
async function buildCliBundle(): Promise<void> {
  if (!await fileExists(path.join(REPO_ROOT, 'packages', 'frontend', 'dist', 'index.html'))) {
    await execFileAsync('pnpm', ['build:frontend'], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }
  for (const script of ['build:cli', 'build:assets', 'build:id']) {
    await execFileAsync('pnpm', [script], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }

  // Copy out of dist/, which `pnpm watch` wipes on every save. Replace the
  // copy wholesale so no stale file survives a rename or deletion.
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
 * Remove podman containers this rig's tests started directly on the host
 * engine (e.g. nested-containers' mock upstream registry) and leaked when a
 * run was interrupted. Selected by `testContainerOwnerLabel`, not by name,
 * because several rigs can share one engine.
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
  // One at a time: a bulk rm aborts on the first orphan entry ("container
  // not known"), which fails even with --ignore.
  await Promise.all(names.map((name) =>
    execFileAsync('podman', ['rm', '-f', '--ignore', name])
      .catch(() => {}),
  ))
}

/**
 * Best-effort delete of leftover per-run test namespaces (`yaac-test-*`)
 * and the cluster-scoped objects they own, which do not go away with the
 * namespace. Errors (no kubectl, no cluster) are ignored.
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
  // ClusterRoles/Bindings, PVs and StorageClasses. Filter on the install
  // namespace label so the developer's real install is left alone.
  try {
    const { stdout } = await execFileAsync('kubectl', [
      'get', 'clusterrole,clusterrolebinding,pv,storageclass', '-l', 'app in (yaac-netd,yaac-server)',
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
 * Build the CLI, pre-build every image the e2e tests use, and push them to
 * the local registry so cluster pods can pull them. Each tag is a content
 * hash of its sources (e.g. yaac-test-base:<hash>), which tests compute the
 * same way to find the expected tag.
 *
 * vitest runs this in its main process, which never sees a project's `env`,
 * so e2e-byo's env (kind-byo's kubeconfig and data dir) is applied by hand.
 */
export async function setup(project: TestProject): Promise<void> {
  if (project.name.startsWith('e2e-byo')) Object.assign(process.env, project.config.env)
  if (testBackend() === 'byo') await requireKindByo()

  // Before the podman check: every suite needs the CLI.
  await buildCliBundle()
  // byo-install-suite's install builds its own images, so the prebuilts
  // would only waste kind-byo registry disk.
  if (project.name === 'e2e-byo-install') return

  // Use the rootful engine the kind node pulls from. Without podman, skip;
  // tests that need it fail on their own.
  ensureRootfulPodmanHost()
  let podmanAvailable = false
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    podmanAvailable = true
  } catch { /* not installed or not running */ }
  if (!podmanAvailable) return

  // Leaked containers with dead conmons hang podman under build load.
  await pruneTestContainers()

  // The trusted chain (base -> tools -> nestable), resolved by the same
  // helper the server and `yaac cluster install` use, so the tags match what
  // test workers look up.
  const { base, tools, nestable } = await resolveTrustedLayers('yaac-test')
  for (const layer of [base, tools, nestable]) {
    await ensureImageByTag(layer.tag, layer.dockerfile, layer.context, layer.buildArgs)
  }

  const proxyHash = await contextHash(PROXY_DIR)
  const proxyTag = `yaac-test-proxy:${proxyHash}`
  await ensureImageByTag(proxyTag, path.join(PROXY_DIR, 'Dockerfile'), PROXY_DIR)

  const netdHash = await contextHash(NETD_DIR)
  const netdTag = `yaac-test-netd:${netdHash}`
  await ensureImageByTag(netdTag, path.join(NETD_DIR, 'Dockerfile'), NETD_DIR)

  // Pods pull from the local registry. Push up front so workers never race
  // a push; already-present tags are skipped.
  if (await registryReachable()) {
    // zstd for the builder pods' parent layers (see
    // TRUSTED_PARENT_COMPRESSION).
    for (const tag of [base.tag, tools.tag, nestable.tag]) {
      await pushImageToRegistry(tag, { compressionFormat: TRUSTED_PARENT_COMPRESSION })
    }
    for (const tag of [proxyTag, netdTag]) {
      await pushImageToRegistry(tag)
    }
    // Digest-pinned upstreams every install mirrors (registry:2, Envoy,
    // podman, curl, Verdaccio). curl is unused by e2e today but mirrored so
    // a future installer test does not fail on a missing image.
    await mirrorPinnedUpstreams()
    // The k8s tiers' server runs as a Deployment (docs/server-in-cluster.md).
    // Its image is built from the CLI bundle above, the same one `runYaac`
    // spawns.
    await buildTestServerImage()
  } else {
    console.log('[global-setup] local registry not reachable — e2e tests requiring a cluster will fail')
  }

  // Reclaim old test-image tags, keeping this run's (on an older checkout
  // they are not the newest). Skipped on a shared engine, where the host
  // runs `pnpm gc:test-images` while every rig is idle.
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
