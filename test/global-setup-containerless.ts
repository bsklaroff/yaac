/**
 * Global setup for the containerless e2e tier. It only builds the CLI: a
 * containerless workspace runs the host's own tools in a checkout, so there
 * are no images, registry, or cluster to prepare.
 */
export { buildCliBundle as setup } from '@yaac/test-utils/cli-bundle'
