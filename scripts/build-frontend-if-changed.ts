/**
 * Runs the frontend vite build only when its inputs changed. Used by the
 * `pnpm watch` dev loop (via `pnpm build:watch`); `pnpm build` always
 * rebuilds. The vite build is the slowest step (~20s and a large memory
 * spike), and a server- or CLI-only edit leaves its output unchanged.
 *
 * Inputs are the frontend package (minus `dist`/`node_modules`), the
 * `@yaac/shared` sources, and `pnpm-lock.yaml`.
 *
 * The input hash is stored in `packages/frontend/dist/.input-hash`, next to
 * the output it describes. `node_modules` may be shared across dev
 * workspaces while `dist` is per-workspace, so a marker kept in
 * `node_modules/.cache` could describe another workspace's build. vite
 * empties `dist` at build start and the marker is written last, so a
 * partial or interrupted build never looks up to date. `build:assets`
 * strips the marker from the published copy.
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

/** Dirs the vite build never reads, including its own output. */
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
  await fs.writeFile(markerFile, `${inputHash}\n`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
