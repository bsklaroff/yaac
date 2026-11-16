import { buildCliBundle } from '#support/cli-bundle'
import { stopAbandonedTestWorkspaces } from '@yaac/test-utils/test-workspaces'

/**
 * Global setup for the containerless e2e tier. A containerless workspace
 * runs the host's own tools in a checkout, so there are no images, registry,
 * or cluster to prepare: it builds the CLI, and stops the workspaces an
 * interrupted run on this rig left on the host, which no file's own cleanup
 * ran for.
 */
export async function setup(): Promise<void> {
  await stopAbandonedTestWorkspaces()
  await buildCliBundle()
}
