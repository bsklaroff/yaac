import path from 'node:path'
import { contextHash, ensureImageByTag } from '@/lib/container/image-builder'
import { imageExists } from '@/lib/container/runtime'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { REDIRECT_INIT_DIR } from '@/lib/project/paths'

/**
 * Compute the redirect-init image tag without building anything. The tag
 * encodes the content of k8s/redirect-init/ (Dockerfile + redirect.sh),
 * so source edits roll every new session pod onto fresh bytes and a
 * stale image can never be used.
 */
export async function resolveRedirectInitImageTag(
  image = process.env.YAAC_REDIRECT_INIT_IMAGE ?? 'yaac-redirect-init',
): Promise<string> {
  const hash = await contextHash(REDIRECT_INIT_DIR)
  return `${image}:${hash}`
}

/**
 * Ensure the redirect-init image (content-hash tagged) exists in the
 * local registry and return its in-cluster ref — same build-or-skip
 * shape as the proxy image (`ensureProxyImage`). Builds with podman only
 * when the registry doesn't already hold the tag.
 *
 * `YAAC_REDIRECT_INIT_IMAGE` is a test-only hook (mirrors
 * YAAC_PROXY_IMAGE) letting the e2e suite point daemons at the pre-built
 * `yaac-test-redirect-init` image.
 */
export async function ensureRedirectInitImage(
  requirePrebuilt = process.env.YAAC_REQUIRE_PREBUILT_IMAGES === '1',
): Promise<string> {
  const localTag = await resolveRedirectInitImageTag()
  if (await registryHasTag(localTag)) return registryRef(localTag)

  if (!await imageExists(localTag)) {
    if (requirePrebuilt) {
      throw new Error(
        `Redirect-init image ${localTag} is missing or stale. ` +
        'Restart the test run so the global setup can rebuild it.',
      )
    }
    await ensureImageByTag(localTag, path.join(REDIRECT_INIT_DIR, 'Dockerfile'), REDIRECT_INIT_DIR)
  }
  return pushImageToRegistry(localTag)
}
