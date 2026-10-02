import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'
import { findRepoRoot } from '@yaac/shared/paths'

const execFileAsync = promisify(execFile)

const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The suite's own copy of dist/, made by `buildCliBundle` in the global
 * setups before any worker starts. `pnpm watch` rebuilds
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

/**
 * Build the CLI and copy it to TEST_CLI_DIR for the suites to spawn.
 * Building every run (an incremental pass takes seconds) means the suites
 * never test a stale bundle.
 *
 * The assets are copied too: in bundled mode PACKAGE_ROOT is the directory
 * holding cli.js, so the migrations, k8s manifests, builtin skills and
 * workspace-bin scripts must sit beside it. The SPA is built only if it
 * never has been, since it is slow and no suite reads it.
 */
export async function buildCliBundle(): Promise<void> {
  const run = (script: string) => execFileAsync('pnpm', [script], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  if (!await fs.access(path.join(REPO_ROOT, 'packages', 'frontend', 'dist', 'index.html')).then(() => true, () => false)) {
    await run('build:frontend')
  }
  for (const script of ['build:cli', 'build:assets', 'build:id']) await run(script)
  // Copy out of dist/, which `pnpm watch` wipes on every save. Replace the
  // copy wholesale so no stale file survives a rename or deletion.
  await fs.rm(TEST_CLI_DIR, { recursive: true, force: true })
  await fs.cp(path.join(REPO_ROOT, 'dist'), TEST_CLI_DIR, { recursive: true })
}
