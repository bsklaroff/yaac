import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { findRepoRoot } from '@yaac/shared/paths'

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The suite's own copy of dist/, made by `buildCliBundle`
 * (test/global-setup.ts) before any worker starts. `pnpm watch` rebuilds
 * dist/ with `clean: true` on every save, which would delete the binary
 * mid-run. It is also the build context of the server image the k8s tiers
 * deploy (`#deployed-server`), so that image's tag can't change mid-run.
 *
 * A separate module because `#deployed-server` is imported by `#cli`.
 */
export const TEST_CLI_DIR = path.join(REPO_ROOT, 'dist-test')

/**
 * The built CLI rather than the source under tsx, which re-transpiles in
 * every spawned process (1.3s vs 0.36s per command, 16.4s vs 5.4s per server
 * start). It is rebuilt before every run, and tests the artifact users run,
 * including the files it reads from beside cli.js (migrations, manifests,
 * skills, workspace-bin).
 */
export const TEST_CLI_ENTRY = path.join(TEST_CLI_DIR, 'cli.js')
