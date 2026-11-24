import path from 'node:path'
import { execFileAsync } from '#drivers/k8s/substrate'
import { buildImage, imageExists, pushImageToRegistry, pushMirrorImage } from './host-images'
import { buildTrustedLayers, ensureLocalBuilderImage } from './host-buildkit'
import { reapOrphanedPodmanProcs } from './host-procs'
import { gcHostImages } from './image-gc'
import {
  UTILITY_MIRROR_TAG,
  UTILITY_UPSTREAM_IMAGE,
  CLOUDFLARED_MIRROR_TAG,
  CLOUDFLARED_UPSTREAM_IMAGE,
  TAILSCALE_MIRROR_TAG,
  TAILSCALE_UPSTREAM_IMAGE,
  resolveTailgateImageTag,
  ENVOY_MIRROR_TAG,
  ENVOY_UPSTREAM_IMAGE,
  NGINX_MIRROR_TAG,
  NGINX_UPSTREAM_IMAGE,
  mirrorMatchesRecord,
  recordMirrorDigest,
  registryRef,
  registryTagState,
  resolveBuilderImageTag,
  resolveTrustedLayers,
  resolveNetdImageTag,
  resolveProxyImageTag,
  VERDACCIO_MIRROR_TAG,
  VERDACCIO_UPSTREAM_IMAGE,
  type ImageLayer,
} from '#drivers/k8s/cluster'
import { NETD_DIR, PROXY_DIR, TAILGATE_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import {
  GVISOR_INSTALLER_MIRROR_TAG,
  GVISOR_INSTALLER_UPSTREAM_IMAGE,
} from './gvisor-installer'
import { hostNodeArchitecture } from './byo-gates'

/**
 * Builds and pushes every image yaac ships, as part of `yaac cluster
 * install` on the CLI's machine.
 *
 * yaac-built images are tagged by content hash, so an unchanged source costs
 * one registry HEAD. The base/tools workspace chain is built with a host
 * buildkitd (host-buildkit.ts); the rest (the builder image, the egress
 * proxy, netd, tailgate) are `podman build`s. Digest-pinned upstream images are
 * mirrored into the registry so nodes need no upstream egress. Image names
 * and tags are defined in `#drivers/k8s/cluster`, which the server also
 * reads (docs/image-builds.md).
 */

interface BuiltinImageDeps {
  log: (message: string) => void
}

/**
 * Build the trusted chain's missing layers with the host buildkitd
 * (host-buildkit.ts), which pushes them. The e2e global setup also calls
 * this, with its own image prefix.
 */
export async function ensureTrustedChain(
  log: (message: string) => void,
  prefix?: string,
  /** A `key=value` label for the BuildKit container (the e2e owner label). */
  containerLabel?: string,
): Promise<void> {
  const { base, tools } = await resolveTrustedLayers(prefix)
  const missing: ImageLayer[] = []
  for (const layer of [base, tools]) {
    // A rebuilt base changes the tools tag, so a present tools is current.
    if (await registryTagState(layer.tag) === 'present') log(`  ${layer.tag} — already in the registry`)
    else missing.push(layer)
  }
  if (missing.length > 0) await buildTrustedLayers(missing, log, prefix, containerLabel)
}

/**
 * Push the builder image (built by `ensureTrustedChain`, which runs it)
 * and record the digest it pushed, which builder pods pull by. Re-pushed
 * when its tag no longer names that record, like a pinned mirror.
 */
export async function pushBuilderImage(prefix?: string): Promise<void> {
  if (await mirrorMatchesRecord(await resolveBuilderImageTag(prefix))) return
  const tag = await ensureLocalBuilderImage(prefix)
  await recordMirrorDigest(tag, await pushMirrorImage(tag))
}

/** Build one yaac-shipped image if the registry lacks it, and push it. */
async function buildShippedImage(localTag: string, contextDir: string): Promise<string> {
  if (await registryTagState(localTag) === 'present') return registryRef(localTag)
  if (!await imageExists(localTag)) {
    await buildImage(localTag, path.join(contextDir, 'Dockerfile'), contextDir)
  }
  return pushImageToRegistry(localTag)
}

/**
 * Throw when a mirrored upstream image has the wrong architecture, usually
 * because the pin names one platform's manifest rather than the multi-arch
 * index. An empty `actual` passes.
 */
export function assertMirrorArch(
  image: string,
  actual: string,
  expected: string = hostNodeArchitecture(),
): void {
  if (!actual.trim() || actual.trim() === expected) return
  throw new Error(
    `${image} is a ${actual.trim()} image but this host is ${expected}. `
    + 'Pin the multi-arch index digest, not one platform\'s child manifest.',
  )
}


/**
 * Mirror one digest-pinned upstream into the local registry: pull, check
 * the architecture, retag, push, and record the digest podman pushed it as
 * (`recordMirrorDigest`). Skipped only while the tag still names its
 * recorded digest, so a rewritten tag is put back. A wrong-arch image would
 * otherwise only show up as a pod crashlooping on `exec format error`.
 */
async function mirrorPinnedImage(upstream: string, mirrorTag: string): Promise<void> {
  if (await mirrorMatchesRecord(mirrorTag)) return
  if (!await imageExists(mirrorTag)) {
    await execFileAsync('podman', ['pull', upstream], { timeout: 600_000 })
    const { stdout: arch } = await execFileAsync('podman', [
      'image', 'inspect', '--format', '{{.Architecture}}', upstream,
    ]).catch(() => ({ stdout: '' }))
    assertMirrorArch(upstream, arch)
    await execFileAsync('podman', ['tag', upstream, mirrorTag])
  }
  await recordMirrorDigest(mirrorTag, await pushMirrorImage(mirrorTag))
}

/**
 * Mirror every digest-pinned upstream yaac runs: Envoy, the builder pods'
 * podman, the gVisor installer's curl, the npm cache's Verdaccio and nginx,
 * and the site tunnels' cloudflared and tailscaled. The e2e global setup
 * also calls this.
 */
export async function mirrorPinnedUpstreams(): Promise<void> {
  await mirrorPinnedImage(ENVOY_UPSTREAM_IMAGE, ENVOY_MIRROR_TAG)
  await mirrorPinnedImage(UTILITY_UPSTREAM_IMAGE, UTILITY_MIRROR_TAG)
  await mirrorPinnedImage(GVISOR_INSTALLER_UPSTREAM_IMAGE, GVISOR_INSTALLER_MIRROR_TAG)
  await mirrorPinnedImage(VERDACCIO_UPSTREAM_IMAGE, VERDACCIO_MIRROR_TAG)
  await mirrorPinnedImage(NGINX_UPSTREAM_IMAGE, NGINX_MIRROR_TAG)
  await mirrorPinnedImage(CLOUDFLARED_UPSTREAM_IMAGE, CLOUDFLARED_MIRROR_TAG)
  await mirrorPinnedImage(TAILSCALE_UPSTREAM_IMAGE, TAILSCALE_MIRROR_TAG)
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

  deps.log('Ensuring the workspace image chain (base → tools)...')
  await ensureTrustedChain(deps.log)
  deps.log('Ensuring the builder image...')
  await pushBuilderImage()

  deps.log('Ensuring the egress proxy image...')
  await buildShippedImage(await resolveProxyImageTag(testEnv.proxyImage), PROXY_DIR)
  deps.log('Ensuring the netd image...')
  await buildShippedImage(await resolveNetdImageTag(testEnv.netdImage), NETD_DIR)
  deps.log('Ensuring the tailgate image...')
  await buildShippedImage(await resolveTailgateImageTag(), TAILGATE_DIR)

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
