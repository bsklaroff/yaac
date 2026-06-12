import path from 'node:path'
import { contextHash, ensureImageByTag } from '@/lib/container/image-builder'
import { imageExists } from '@/lib/container/runtime'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { RELAY_DIR } from '@/lib/project/paths'

/**
 * Compute the relay image tag without building anything. The tag encodes
 * the content of k8s/relay/ (Dockerfile + go.mod + main.go), so a source
 * edit rolls every new session pod onto fresh bytes and a stale binary can
 * never be used.
 */
export async function resolveRelayImageTag(
  image = process.env.YAAC_RELAY_IMAGE ?? 'yaac-relay',
): Promise<string> {
  const hash = await contextHash(RELAY_DIR)
  return `${image}:${hash}`
}

/**
 * Ensure the relay image (content-hash tagged) exists in the local
 * registry and return its in-cluster ref — same build-or-skip shape as
 * the proxy and redirect-init images. The Dockerfile is multi-stage
 * (golang builder → static binary on alpine), so the build needs no host
 * Go toolchain.
 *
 * `YAAC_RELAY_IMAGE` is a test-only hook (mirrors YAAC_PROXY_IMAGE)
 * letting the e2e suite point daemons at the pre-built `yaac-test-relay`
 * image.
 */
export async function ensureRelayImage(
  requirePrebuilt = process.env.YAAC_REQUIRE_PREBUILT_IMAGES === '1',
): Promise<string> {
  const localTag = await resolveRelayImageTag()
  if (await registryHasTag(localTag)) return registryRef(localTag)

  if (!await imageExists(localTag)) {
    if (requirePrebuilt) {
      throw new Error(
        `Relay image ${localTag} is missing or stale. ` +
        'Restart the test run so the global setup can rebuild it.',
      )
    }
    await ensureImageByTag(localTag, path.join(RELAY_DIR, 'Dockerfile'), RELAY_DIR)
  }
  return pushImageToRegistry(localTag)
}
