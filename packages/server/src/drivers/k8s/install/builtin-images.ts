import path from 'node:path'
import {
  buildImage,
  ensureImageByTag,
  failImageBuild,
  finishImageBuild,
  gcHostImages,
  ingestImageBuildLine,
  registerImageBuild,
  resolveTrustedLayers,
} from '#drivers/k8s/image-engine'

import {
  execFileAsync,
  imageExists,
  pushImageToRegistry,
  reapOrphanedPodmanProcs,
  registryHasTag,
  registryRef,
} from '#drivers/k8s/container'
import {
  BUILDER_LOCAL_TAG,
  BUILDER_UPSTREAM_IMAGE,
  ENVOY_MIRROR_TAG,
  ENVOY_UPSTREAM_IMAGE,
  REGISTRY_MIRROR_TAG,
  REGISTRY_UPSTREAM_IMAGE,
  resolveNetdImageTag,
  resolveProxyImageTag,
} from '#drivers/k8s/cluster'
import { podUid } from '#drivers/k8s/substrate'
import { NETD_DIR, PROXY_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'
import {
  GVISOR_INSTALLER_MIRROR_TAG,
  GVISOR_INSTALLER_UPSTREAM_IMAGE,
} from './gvisor-installer'

/**
 * Every image yaac itself ships, produced on the machine running the yaac
 * CLI — the image half of `yaac cluster install`.
 *
 * Two kinds. The yaac-built ones (the base/tools/nestable worktree chain,
 * the egress proxy, netd) are `podman build` over build contexts the npm
 * artifact carries, tagged by content hash so an unchanged source tree
 * costs one registry HEAD. The rest are digest-pinned upstreams
 * (registry:2, Envoy, podman-stable, the gVisor installer's curl) mirrored
 * into the registry so nodes pull them with no upstream egress — and so an
 * offline install still works once they are in the host store.
 *
 * This is the only module that *produces* any of them. Each image's
 * identity — its pin or its content-hash tag — stays beside the lookup the
 * server does in `#drivers/k8s/cluster`, because both halves need the same
 * name for the same bytes; what lives here is the production, which only
 * install performs (docs/trust-split-builds.md).
 */

/**
 * Compression for the trusted-layer pushes that feed builder-pod parent
 * pulls: zstd cuts a pod's empty-graphroot parent pull from 65.6s to 40.4s
 * (measured). Node containerd zstd pulls are validated live — worktree pods
 * pull product manifests referencing these blobs.
 */
export const TRUSTED_PARENT_COMPRESSION = 'zstd' as const

export interface BuiltinImageDeps {
  log: (message: string) => void
}

/**
 * Build-or-skip one yaac-shipped build context and push it, tracking the
 * build in the shared registry so it surfaces in the webapp's build list
 * like every other one. Shared infrastructure, so it registers with no
 * owning project.
 */
async function buildShippedImage(
  localTag: string,
  contextDir: string,
  layer: 'proxy' | 'netd',
): Promise<string> {
  if (await registryHasTag(localTag)) return registryRef(localTag)

  if (!await imageExists(localTag)) {
    const id = registerImageBuild({ tag: localTag, layer, action: 'build', reason: 'session' })
    serverLog(`[build] starting ${localTag} (${layer})`)
    try {
      await buildImage(localTag, path.join(contextDir, 'Dockerfile'), contextDir, undefined, {
        onLog: (line) => ingestImageBuildLine(id, line),
      })
      finishImageBuild(id)
    } catch (err) {
      failImageBuild(id, err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return pushImageToRegistry(localTag)
}

/** podman's GOARCH name for this host — the node shares it (kind's node is a
 *  container here), so it is also the arch every mirrored image must be. */
export function hostImageArch(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch
}

/**
 * Throw when a mirrored upstream image is built for the wrong architecture,
 * naming the likely cause (a pin that points at a child manifest rather than
 * the index). An empty/unknown `actual` is accepted — the check must never be
 * the reason a mirror fails.
 */
export function assertMirrorArch(
  image: string,
  actual: string,
  expected: string = hostImageArch(),
): void {
  if (!actual.trim() || actual.trim() === expected) return
  throw new Error(
    `${image} is a ${actual.trim()} image but this host is ${expected}. `
    + 'Pin the multi-arch index digest, not one platform\'s child manifest.',
  )
}


/**
 * Mirror one digest-pinned upstream into the local registry: pull it, check
 * the architecture, retag it under the mirror name, push.
 *
 * The arch re-check is what a bad re-pin fails on. A pin naming one
 * platform's CHILD manifest rather than the multi-arch index mirrors those
 * bytes onto every host, and a mismatched node then crashloops on `exec
 * format error` — which surfaces only as the workload never going ready.
 */
async function mirrorPinnedImage(upstream: string, mirrorTag: string): Promise<string> {
  if (await registryHasTag(mirrorTag)) return registryRef(mirrorTag)
  if (!await imageExists(mirrorTag)) {
    await execFileAsync('podman', ['pull', upstream], { timeout: 600_000 })
    const { stdout: arch } = await execFileAsync('podman', [
      'image', 'inspect', '--format', '{{.Architecture}}', upstream,
    ]).catch(() => ({ stdout: '' }))
    assertMirrorArch(upstream, arch)
    await execFileAsync('podman', ['tag', upstream, mirrorTag])
  }
  return pushImageToRegistry(mirrorTag)
}

/**
 * Mirror every digest-pinned upstream yaac runs: the per-project
 * registries' `registry:2`, netd's Envoy sidecar, the sandboxed builder
 * pods' podman, and the gVisor installer's curl.
 *
 * Exported because the e2e global setup needs exactly this set and nothing
 * else of an install — its own images are test-prefixed builds, but these
 * four are the same digests either way.
 */
export async function mirrorPinnedUpstreams(): Promise<void> {
  await mirrorPinnedImage(REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG)
  await mirrorPinnedImage(ENVOY_UPSTREAM_IMAGE, ENVOY_MIRROR_TAG)
  await mirrorPinnedImage(BUILDER_UPSTREAM_IMAGE, BUILDER_LOCAL_TAG)
  await mirrorPinnedImage(GVISOR_INSTALLER_UPSTREAM_IMAGE, GVISOR_INSTALLER_MIRROR_TAG)
}

/**
 * Build/mirror and push every built-in image, then sweep the host store.
 *
 * Every step is build-or-skip against the registry, so a re-run after an
 * upgrade that changed nothing costs a handful of HEADs. The worktree
 * chain leads because it is the long pole — base is a full apt/Node build
 * on a cold store, and the layers above it are serial by construction
 * (each is the next one's FROM).
 */
export async function buildBuiltinImages(deps: BuiltinImageDeps): Promise<void> {
  // Before anything decides a tag is missing: an install killed mid-build
  // leaves a `podman build` that commits its tag later, and starting a
  // second build of the same tag beside it is how two engines end up
  // fighting over the image-store lock. Best-effort — a failed reap costs
  // at most that duplicate.
  await reapOrphanedPodmanProcs().catch((err: unknown) => {
    deps.log(`note: could not reap a previous install's podman processes: ${String(err)}`)
  })

  const prefix = testEnv.imagePrefix ?? 'yaac'
  // Built for the uid the server pod will run as, which is THIS machine's:
  // the Deployment this install applies stamps the same number, because the
  // data dir is a hostPath only its owner can write (see `podUid`). Passed
  // explicitly rather than left to the default so the two decisions read as
  // the one decision they are.
  const { base, tools, nestable } = await resolveTrustedLayers(prefix, podUid())

  deps.log('Ensuring the worktree image chain (base → tools → nestable)...')
  for (const layer of [base, tools, nestable]) {
    // The registry, not the host store, is what a create resolves — so a
    // tag already there is done, however this host's store looks.
    if (await registryHasTag(layer.tag)) {
      deps.log(`  ${layer.tag} — already in the registry`)
      continue
    }
    deps.log(`  ${layer.tag}`)
    await ensureImageByTag(layer.tag, layer.dockerfile, layer.context, layer.buildArgs)
    await pushImageToRegistry(layer.tag, { compressionFormat: TRUSTED_PARENT_COMPRESSION })
  }

  deps.log('Ensuring the egress proxy image...')
  await buildShippedImage(await resolveProxyImageTag(testEnv.proxyImage), PROXY_DIR, 'proxy')
  deps.log('Ensuring the netd image...')
  await buildShippedImage(await resolveNetdImageTag(testEnv.netdImage), NETD_DIR, 'netd')

  deps.log('Ensuring the pinned upstream mirrors...')
  await mirrorPinnedUpstreams()

  // The host store is this machine's build cache and nothing else — every
  // consumer resolves through the registry — so retiring old generations
  // here is pure reclaim. Fails soft: a full disk is a real problem, but
  // not one that should abort an otherwise complete install.
  try {
    const { retired, pruned } = await gcHostImages()
    if (retired.length > 0 || pruned > 0) {
      deps.log(
        `Reclaimed ${retired.length} stale image tag(s) and ${pruned} dangling image(s) `
        + 'from the host build store.',
      )
    }
  } catch (err) {
    deps.log(
      'note: could not sweep the host image store '
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`,
    )
  }
}
