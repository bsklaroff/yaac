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
  VERDACCIO_MIRROR_TAG,
  VERDACCIO_UPSTREAM_IMAGE,
} from '#drivers/k8s/cluster'
import { NETD_DIR, PROXY_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { serverLog } from '#log'
import {
  GVISOR_INSTALLER_MIRROR_TAG,
  GVISOR_INSTALLER_UPSTREAM_IMAGE,
} from './gvisor-installer'

/**
 * Builds and pushes every image yaac ships, as part of `yaac cluster
 * install` on the CLI's machine.
 *
 * yaac-built images (the base/tools/nestable workspace chain, the egress
 * proxy, netd) are `podman build`s tagged by content hash, so an unchanged
 * source costs one registry HEAD. Digest-pinned upstream images are
 * mirrored into the registry so nodes need no upstream egress. Image names
 * and tags are defined in `#drivers/k8s/cluster`, which the server also
 * reads (docs/trust-split-builds.md).
 */

/**
 * Compression for trusted-layer pushes. Builder pods pull these as parents,
 * and zstd cut that pull from 65.6s to 40.4s in measurement. Node
 * containerd pulls zstd blobs fine.
 */
export const TRUSTED_PARENT_COMPRESSION = 'zstd' as const

export interface BuiltinImageDeps {
  log: (message: string) => void
}

/**
 * Build one yaac-shipped image if the registry lacks it, and push it. The
 * build is registered (with no project) so it shows in the build list.
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

/** podman's GOARCH name for this host, which mirrored images must match. */
export function hostImageArch(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch
}

/**
 * Throw when a mirrored upstream image has the wrong architecture, usually
 * because the pin names one platform's manifest rather than the multi-arch
 * index. An empty `actual` passes.
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
 * Mirror one digest-pinned upstream into the local registry: pull, check
 * the architecture, retag, push. A wrong-arch image would otherwise only
 * show up as a pod crashlooping on `exec format error`.
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
 * Mirror every digest-pinned upstream yaac runs: `registry:2`, Envoy, the
 * builder pods' podman, the gVisor installer's curl, and Verdaccio. The
 * e2e global setup also calls this.
 */
export async function mirrorPinnedUpstreams(): Promise<void> {
  await mirrorPinnedImage(REGISTRY_UPSTREAM_IMAGE, REGISTRY_MIRROR_TAG)
  await mirrorPinnedImage(ENVOY_UPSTREAM_IMAGE, ENVOY_MIRROR_TAG)
  await mirrorPinnedImage(BUILDER_UPSTREAM_IMAGE, BUILDER_LOCAL_TAG)
  await mirrorPinnedImage(GVISOR_INSTALLER_UPSTREAM_IMAGE, GVISOR_INSTALLER_MIRROR_TAG)
  await mirrorPinnedImage(VERDACCIO_UPSTREAM_IMAGE, VERDACCIO_MIRROR_TAG)
}

/**
 * Build or mirror and push every built-in image, then GC the host image
 * store. Each step is skipped when the registry already has the tag. The
 * workspace chain goes first because it takes longest.
 */
export async function buildBuiltinImages(deps: BuiltinImageDeps): Promise<void> {
  // A killed earlier install can leave a `podman build` running; a second
  // build of the same tag would fight it for the image-store lock.
  await reapOrphanedPodmanProcs().catch((err: unknown) => {
    deps.log(`note: could not reap a previous install's podman processes: ${String(err)}`)
  })

  const prefix = testEnv.imagePrefix ?? 'yaac'
  const { base, tools, nestable } = await resolveTrustedLayers(prefix)

  deps.log('Ensuring the workspace image chain (base → tools → nestable)...')
  for (const layer of [base, tools, nestable]) {
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

  // The host store is only a build cache; everything pulls from the
  // registry. A failed GC does not fail the install.
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
