import { legacyTrustedChainRepo, retireStaleGenerations } from '@yaac/server/drivers/k8s/install/image-gc'
import { TEST_IMAGE_PREFIX } from '@yaac/test-utils/setup'

/**
 * Every repo the suite builds or stages on the host engine. `yaac cluster
 * install`'s host GC skips these, so only `gcTestImages` reclaims them.
 */
const TEST_IMAGE_REPO = new RegExp(`^(localhost(:\\d+)?/)?${TEST_IMAGE_PREFIX}-`)

/**
 * Retire all but the newest two generations of each `yaac-test-*` repo,
 * plus the `keepTags` a caller is still using, and every tag of the old
 * podman-built trusted chain.
 *
 * "Newest" is by build time, and an older checkout reuses old tags, so the
 * global setup passes the tags it just resolved to keep them.
 *
 * Unsafe while another run shares the podman engine, since one run's sweep
 * could untag what the other is about to push. So the global setup skips it
 * under `YAAC_TEST_SHARED_ENGINE=1`, and such hosts run
 * `pnpm gc:test-images` while every rig is idle.
 */
export async function gcTestImages(keepTags: string[] = []): Promise<string[]> {
  return [
    ...await retireStaleGenerations(TEST_IMAGE_REPO, new Set(keepTags)),
    ...await retireStaleGenerations(legacyTrustedChainRepo(TEST_IMAGE_PREFIX), new Set(), 0),
  ]
}
