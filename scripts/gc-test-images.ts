/**
 * `pnpm gc:test-images` — retire superseded `yaac-test-*` generations from
 * the host podman engine (see `gcTestImages`). The e2e global setup already
 * does this on a host with one test run at a time; this is for a host that
 * sets `YAAC_TEST_SHARED_ENGINE=1` because several test rigs build into one
 * engine. Run it only while none of them has a run in flight.
 */
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import { gcTestImages } from '@yaac/test-utils/test-images'

ensureRootfulPodmanHost()
const retired = await gcTestImages()
for (const ref of retired) console.log(`retired ${ref}`)
console.log(`retired ${retired.length} stale yaac-test-* tag(s)`)
