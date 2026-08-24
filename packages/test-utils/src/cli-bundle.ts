import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { findRepoRoot } from '@yaac/shared/paths'

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The suite's own copy of the built CLI, taken from dist/ by
 * `buildCliBundle` (test/global-setup.ts) before any worker starts.
 *
 * A copy rather than dist/ itself because `pnpm watch` builds into dist/ on
 * every save, with `clean: true` — a save landing mid-run would otherwise
 * delete the binary these suites are spawning. Snapshotting once per run
 * decouples them: the watcher can rebuild dist/ as often as it likes and an
 * in-flight run keeps the bundle it started with. 7MB, so the copy costs
 * nothing next to what it buys.
 *
 * It is also the build context of the dev server image the k8s tiers deploy
 * (`#deployed-server`), for the same reason and with the same consequence:
 * the image tag is the content hash of THIS directory, so it cannot move
 * under a running suite.
 *
 * Its own module because both of those consumers need it and one of them —
 * the deployed-server fixture — is imported BY `#cli`, so a constant living
 * there would be a cycle.
 */
export const TEST_CLI_DIR = path.join(REPO_ROOT, 'dist-test')

/**
 * The built CLI, not `packages/cli/src/cli.ts` under tsx — every
 * `runYaac`/`spawnYaacServer` here is a fresh process, and tsx re-transpiles
 * the whole graph in each one: 1.3s for a CLI command, 16.4s for a server to
 * report ready, against 0.36s and 5.4s from the bundle. Across the suite's
 * ~160 CLI spawns that is minutes per run.
 *
 * Rebuilt from source before every run, so this can never test a stale
 * bundle. It also means these suites exercise the artifact users actually
 * run — including its bundled-mode paths, where PACKAGE_ROOT is the
 * directory holding cli.js and the migrations, k8s manifests, builtin skills
 * and worktree-bin scripts are read from the copies beside it. That is why
 * the snapshot is the whole of dist/ and not just cli.js.
 */
export const TEST_CLI_ENTRY = path.join(TEST_CLI_DIR, 'cli.js')
