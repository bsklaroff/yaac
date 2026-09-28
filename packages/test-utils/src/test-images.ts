import { retireStaleGenerations } from '@yaac/server/drivers/k8s/image-engine/image-gc'
import { TEST_IMAGE_PREFIX } from '#setup'

/**
 * Every repo the suite builds or stages on the host engine. Each e2e run's
 * global setup mints a generation — `yaac-test-server` on nearly every
 * commit, the multi-GB base/tools/nestable on every Dockerfile change — and
 * `yaac cluster install`'s host GC deliberately leaves them alone, so this
 * is the only thing that reclaims them.
 */
const TEST_IMAGE_REPO = new RegExp(`^(localhost(:\\d+)?/)?${TEST_IMAGE_PREFIX}-`)

/**
 * Retire all but the newest two generations of each `yaac-test-*` repo,
 * plus the `keepTags` a caller is still using.
 *
 * "Newest" is build time, and a run on an older checkout reuses tags built
 * long ago (`ensureImageByTag` skips a tag the host already has), so the
 * global setup passes the tags it just resolved. Without that, its own
 * trusted chain could be retired and rebuilt on every run while you
 * alternate branches.
 *
 * Only safe while no OTHER e2e run shares this podman engine: both runs
 * build the same tag names, so a sweep from one can untag a generation the
 * other's global setup just confirmed and is about to push. Hence the two
 * callers: the global setup runs it after its own builds and pushes unless
 * the host declares `YAAC_TEST_SHARED_ENGINE=1`, and a host that does
 * (several test rigs on one engine) runs `pnpm gc:test-images` itself at a
 * moment it knows every rig is idle.
 */
export async function gcTestImages(keepTags: string[] = []): Promise<string[]> {
  return retireStaleGenerations(TEST_IMAGE_REPO, new Set(keepTags))
}
