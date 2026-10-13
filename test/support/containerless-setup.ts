import { setWorkspaceDriver } from '@yaac/server/drivers/driver'
import { createContainerlessDriver } from '@yaac/server/drivers/containerless'

/**
 * Register the real containerless driver for the `api-containerless`
 * project. Like `cluster-setup.ts`: api tests build the app in-process
 * (`buildApp`), skipping the composition root that would register one.
 */
setWorkspaceDriver(createContainerlessDriver())
