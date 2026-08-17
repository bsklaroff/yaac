import {
  ensureImageByTag,
  gcHostImages,
  resolveTrustedLayers,
} from '#drivers/k8s/image-engine'
import { pushImageToRegistry, reapOrphanedPodmanProcs, registryHasTag } from '#drivers/k8s/container'
import { testEnv } from '@yaac/shared/env'
import { mirrorEnvoyImage, buildNetdImage } from './netd'
import { mirrorGvisorInstallerImage } from './gvisor-installer'
import { mirrorRegistryImage } from './project-registry'
import { buildProxyImage } from './proxy-image'
import { mirrorBuilderImage } from './builder-image'

/**
 * Every image yaac itself ships, built and pushed on the machine running
 * the yaac CLI — the image half of `yaac cluster install`.
 *
 * Two kinds live here. The yaac-built ones (the base/tools/nestable
 * worktree chain, the egress proxy, netd) are `podman build` over build
 * contexts the npm artifact carries, tagged by content hash so an
 * unchanged source tree costs one registry HEAD. The rest are
 * digest-pinned upstreams (registry:2, Envoy, podman-stable, the gVisor
 * installer's curl) mirrored into the registry so nodes pull them with no
 * upstream egress — and so an offline install still works once they are
 * in the host store.
 *
 * The server builds none of it (docs/trust-split-builds.md): it looks
 * every one of these up in the registry and points at this command when
 * a tag is missing. That is what lets the server run without a container
 * engine at all — and, once it is a pod, without a host.
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
  const { base, tools, nestable } = await resolveTrustedLayers(prefix)

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
  await buildProxyImage()
  deps.log('Ensuring the netd image...')
  await buildNetdImage()

  deps.log('Ensuring the pinned upstream mirrors...')
  await mirrorRegistryImage()
  await mirrorEnvoyImage()
  await mirrorBuilderImage()
  await mirrorGvisorInstallerImage()

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
