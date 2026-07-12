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
  // `ditto` copies the .app bundle preserving its internal symlinks (the
  // Electron framework's `Versions/Current → A`). A cpSync with `dereference`
  // rewrites those into absolute paths and breaks the bundle — Electron then
  // can't find icudtl.dat and the GPU process fatally crashes on launch.
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
