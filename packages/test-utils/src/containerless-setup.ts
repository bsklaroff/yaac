import { setWorktreeDriver } from '@yaac/server/drivers/driver'
import { createContainerlessDriver } from '@yaac/server/drivers/containerless'

/**
 * Register the containerless runtime for the `api-containerless` project.
 *
 * The twin of `cluster-setup.ts`, and there for the same reason: an api test
 * builds the Hono app in-process (`buildApp`) without going through the
 * composition root, so nothing would have registered a driver and the first
 * route to reach the substrate would throw. This is that project's stand-in
 * for the root.
 *
 * The REAL containerless driver, not a fake — a fake would answer whatever
 * it was told to, while this exercises the actual assembly, including every
 * verb that degrades to empty and every route that refuses because this
 * substrate has no such feature.
 *
 * No cluster hygiene here, unlike its twin: this project creates no
 * namespace, no pods and no images, which is exactly why it runs without a
 * cluster at all.
 */
setWorktreeDriver(createContainerlessDriver())
