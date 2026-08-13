import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { TEST_CLI_DIR } from '@yaac/test-utils/cli'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Global setup for the containerless e2e tier: build the CLI, and nothing
 * else.
 *
 * The cluster tier's setup is dominated by images — five content-hashed
 * builds plus the digest-pinned mirrors, pushed to a local registry before
 * any worker starts. None of it applies here: a containerless worktree runs
 * the host's own tools in a checkout, so there is no image to build, no
 * registry to push to and no cluster to keep clean. What remains is the one
 * thing both tiers need, which is a current bundle for the suites to spawn.
 *
 * That is also why this tier can run in parallel where the cluster one
 * cannot: nothing here is shared between workers except the host, and each
 * worker's server already gets its own data dir and port.
 */

/**
 * Build the CLI the suites spawn, then hand them their own copy
 * (TEST_CLI_DIR — see packages/test-utils/src/cli.ts).
 *
 * The same reasoning as the cluster tier's: a fresh process running the
 * source under tsx pays the transpile every spawn, and building here
 * unconditionally is what makes "the suite tested a stale bundle"
 * unrepresentable.
 */
export async function setup(): Promise<void> {
  // build:assets copies packages/frontend/dist rather than building it, so a
  // tree that has never built the SPA needs that first.
  if (!await fileExists(path.join(REPO_ROOT, 'packages', 'frontend', 'dist', 'index.html'))) {
    await execFileAsync('pnpm', ['build:frontend'], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }
  for (const script of ['build:cli', 'build:assets', 'build:id']) {
    await execFileAsync('pnpm', [script], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }

  // Snapshot it out of dist/ before the workers start: `pnpm watch` rebuilds
  // dist/ with `clean: true` on every save, so a save landing mid-run would
  // delete the binary the suites are spawning.
  await fs.rm(TEST_CLI_DIR, { recursive: true, force: true })
  await fs.cp(path.join(REPO_ROOT, 'dist'), TEST_CLI_DIR, { recursive: true })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
