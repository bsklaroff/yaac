import type { TestProject } from 'vitest/node'
import { buildCliBundle } from '#support/cli-bundle'
import { setup as buildDbSnapshot } from '@yaac/test-utils/db-snapshot'
import { stopAbandonedTestWorkspaces } from '@yaac/test-utils/test-workspaces'

/**
 * Global setup for the containerless e2e tier. A containerless workspace
 * runs the host's own tools in a checkout, so there are no images, registry,
 * or cluster to prepare: it builds the CLI and the database dump each
 * file's servers start from, and stops the workspaces an interrupted run on
 * this rig left on the host, which no file's own cleanup ran for.
 */
export async function setup(project: TestProject): Promise<void> {
  await stopAbandonedTestWorkspaces()
  await Promise.all([buildCliBundle(), buildDbSnapshot(project)])
}
