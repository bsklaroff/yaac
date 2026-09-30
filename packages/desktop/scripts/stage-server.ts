import { execFileSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage what the packaged app bundles beside the Electron shell:
 *
 *   staging/server — the publish artifact (`pnpm pack` of the repo root, which
 *     rewrites `catalog:` pins) with its production dependencies installed.
 *     The root manifest is the dependency list; scripts/check-cli-externals.ts
 *     checks it at build time.
 *   staging/node — a copy of the Node running this script, so the app runs
 *     the server (and node-pty) without a Node install on the machine.
 *
 * scripts/after-pack.cjs copies both into yaac.app/Contents/Resources.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(pkgRoot, '..', '..')
const staging = path.join(pkgRoot, 'staging')

if (!existsSync(path.join(repoRoot, 'dist', 'cli.js'))) {
  throw new Error('no dist/cli.js at the repo root — run `pnpm -w build` first')
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

execFileSync('pnpm', ['pack', '--pack-destination', staging], { cwd: repoRoot, stdio: 'inherit' })
const tarball = readdirSync(staging).find((f) => f.endsWith('.tgz'))
if (!tarball) throw new Error('pnpm pack produced no tarball in staging/')
execFileSync('tar', ['-xzf', path.join(staging, tarball), '-C', staging])
renameSync(path.join(staging, 'package'), path.join(staging, 'server'))
rmSync(path.join(staging, tarball))

const manifestPath = path.join(staging, 'server', 'package.json')
const manifestRaw = readFileSync(manifestPath, 'utf8')
if (manifestRaw.includes('catalog:')) {
  throw new Error('staged package.json still has catalog: pins — pnpm pack did not rewrite them')
}
// npm resolves devDependencies even under --omit=dev, and they include
// workspace-only @yaac/* names. The lifecycle scripts assume the source tree.
const manifest = JSON.parse(manifestRaw) as Record<string, unknown>
delete manifest.devDependencies
delete manifest.scripts
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log('[stage] npm install --omit=dev in staging/server')
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: path.join(staging, 'server'),
  stdio: 'inherit',
})

// The staged server runs on this binary, and native deps were fetched for its
// ABI, so warn when it differs from the pinned major.
const nvmrc = readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim()
const pinnedMajor = nvmrc.replace(/^v/, '').split('.')[0]
const runningMajor = process.version.replace(/^v/, '').split('.')[0]
if (pinnedMajor !== runningMajor) {
  console.warn(`[stage] WARNING: staging Node ${process.version}, but .nvmrc pins ${nvmrc}`)
}
mkdirSync(path.join(staging, 'node'), { recursive: true })
cpSync(process.execPath, path.join(staging, 'node', 'node'))
chmodSync(path.join(staging, 'node', 'node'), 0o755)
console.log(`[stage] staged server + node ${process.version} under ${staging}`)
