import { existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Copy the built `.app` into /Applications (fallback ~/Applications) so the
 * Dock shortcut launches the latest build. Run after `pnpm app:build` (or via
 * `pnpm app:install`, which chains both).
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(pkgRoot, 'dist-app')

const app = readdirSync(outDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(outDir, d.name, 'yaac.app'))
  .find((p) => existsSync(p))
if (!app) throw new Error('no built yaac.app under dist-app/ — run `pnpm app:build` first')

function install(dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  // `ditto` preserves the bundle's internal symlinks (Electron's
  // `Versions/Current → A`); cpSync breaks them and Electron then crashes on
  // launch because it can't find icudtl.dat.
  execFileSync('ditto', [app as string, dest])
}

let dest = '/Applications/yaac.app'
try {
  install(dest)
} catch {
  const userApps = path.join(os.homedir(), 'Applications')
  mkdirSync(userApps, { recursive: true })
  dest = path.join(userApps, 'yaac.app')
  install(dest)
}
console.log(`[install] ${app} → ${dest}`)
