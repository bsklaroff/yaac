import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { TEST_CLI_DIR } from '@yaac/test-utils/cli'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Global setup for the containerless e2e tier. It only builds the CLI: a
 * containerless workspace runs the host's own tools in a checkout, so there
 * are no images, registry, or cluster to prepare. Workers share nothing but
 * the host (each server gets its own data dir and port), so this tier can
 * run in parallel.
 */

/**
 * Build the CLI and copy it to TEST_CLI_DIR
 * (packages/test-utils/src/cli-bundle.ts) for the suites to spawn. Building
 * every run means the suites never test a stale bundle, and a bundle avoids
 * paying the tsx transpile on every spawn.
 * build:assets only copies packages/frontend/dist, so the SPA is built first
 * if it never has been.
 */
export async function setup(): Promise<void> {
  if (!await fileExists(path.join(REPO_ROOT, 'packages', 'frontend', 'dist', 'index.html'))) {
    await execFileAsync('pnpm', ['build:frontend'], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }
  for (const script of ['build:cli', 'build:assets', 'build:id']) {
    await execFileAsync('pnpm', [script], { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  }

  // Copy out of dist/: `pnpm watch` wipes dist/ on every save, which would
  // delete the binary mid-run.
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
