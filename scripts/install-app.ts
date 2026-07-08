import { existsSync, rmSync, cpSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Copy the built `.app` into /Applications (fallback ~/Applications) so the
 * Dock shortcut launches the latest build. Run after `pnpm app:build` (or via
 * `pnpm app:install`, which chains both).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist-app')

const app = readdirSync(outDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(outDir, d.name, 'yaac.app'))
  .find((p) => existsSync(p))
if (!app) throw new Error('no built yaac.app under dist-app/ — run `pnpm app:build` first')

function install(dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  cpSync(app as string, dest, { recursive: true, dereference: true })
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
