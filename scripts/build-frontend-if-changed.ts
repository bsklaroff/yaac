/**
 * `pnpm build:frontend` gated on a content hash of the frontend's
 * inputs — used by the `pnpm watch` dev loop (via `pnpm build:watch`),
 * NOT by the publish build (`pnpm build` always rebuilds).
 *
 * The vite/rollup production build is by far the most expensive step in
 * a rebuild (~20s + a large rollup memory spike, thousands of modules),
 * yet a server- or CLI-only edit leaves the frontend output
 * byte-identical. So this skips the vite build when none of the
 * frontend's inputs changed since the last successful build, turning a
 * server-only save from a full rebuild into just the tsup bundle + copies.
 *
 * "Inputs" = everything vite reads to produce `packages/frontend/dist`:
 * the frontend package (minus its own `dist`/`node_modules`), the
 * `@yaac/shared` sources it imports, and `pnpm-lock.yaml` (a dependency
 * bump changes the bundle).
 *
 * The hash marker lives INSIDE `packages/frontend/dist` (as
 * `.input-hash`), co-located with the very output it describes. That
 * coupling is deliberate: `node_modules` (and the pnpm store) can be a
 * shared mount across yaac dev worktrees to save disk, but the source
 * tree — including `packages/frontend/dist` — is per-worktree. A marker
 * in `node_modules/.cache` could then describe a sibling worktree's dist
 * and green-light a skip this worktree's dist doesn't reflect. Keeping
 * the marker in the dist it describes makes them share fate: vite's
 * `emptyOutDir` wipes both at build start, and the marker is written
 * last, so a missing/partial dist (or a mid-build kill) can never read
 * as an up-to-date skip. `build:assets` strips the marker from the
 * copy it places in `dist/frontend` so the publish-shaped tree stays
 * clean. A missing marker or missing `dist/index.html` forces a build.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectFileHashes, combineHashes, hashBuffer } from '@yaac/shared/content-hash'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..')

const frontendDir = path.join(repoRoot, 'packages', 'frontend')
const frontendDist = path.join(frontendDir, 'dist')
const markerFile = path.join(frontendDist, '.input-hash')

// Dirs never read by the vite build; skipping them keeps the walk cheap
// and stops the frontend's own build output from feeding its input hash.
const SKIP_DIRS = new Set(['dist', 'node_modules'])

async function hashInputs(): Promise<string> {
  const entries = [
    ...(await collectFileHashes(frontendDir, { prefix: 'frontend', skipDirs: SKIP_DIRS })),
    ...(await collectFileHashes(path.join(repoRoot, 'packages', 'shared', 'src'), {
      prefix: 'shared',
    })),
  ]
  const lock = path.join(repoRoot, 'pnpm-lock.yaml')
  if (existsSync(lock)) {
    entries.push({ rel: 'pnpm-lock.yaml', hash: hashBuffer(await fs.readFile(lock)) })
  }
  return combineHashes(entries)
}

function runFrontendBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@yaac/frontend', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`frontend build exited with code ${String(code)}`))
    })
  })
}

async function main(): Promise<void> {
  const inputHash = await hashInputs()
  const cached = await fs.readFile(markerFile, 'utf8').then((s) => s.trim()).catch(() => '')
  const distReady = existsSync(path.join(frontendDist, 'index.html'))

  if (cached === inputHash && distReady) {
    console.error('[build:frontend] inputs unchanged — reusing packages/frontend/dist')
    return
  }

  await runFrontendBuild()
  // Written last, into the dist it describes: a skip is only ever taken
  // when this marker survives alongside a complete dist.
  await fs.writeFile(markerFile, `${inputHash}\n`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
