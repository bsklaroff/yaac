import {
  readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, chmodSync, existsSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage the daemon bundle for electron-builder: `dist/` + a production-only
 * `node_modules` (just the deps the daemon bundle externalizes) + a standalone
 * Node binary. electron-builder ships `staging/{daemon,node}` as unpacked
 * extraResources so the standalone Node can resolve them (a standalone Node
 * can't read app.asar). See plans/electron-app.md, "Phase 3 packaging".
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
}

// dist/cli.js externalizes exactly these production deps (from scanning the
// bundle's bare imports). Ship only them — not the vite-bundled frontend deps
// or the agent CLIs — so the app stays lean.
const DAEMON_DEPS = [
  '@hono/node-server', '@hono/node-ws', '@hono/zod-validator', 'hono',
  'zod', 'simple-git', 'smol-toml', 'yaml', 'commander', '@lydell/node-pty',
]

const deps: Record<string, string> = {}
for (const name of DAEMON_DEPS) {
  const version = pkg.dependencies[name]
  if (!version) throw new Error(`daemon dep ${name} missing from package.json dependencies`)
  deps[name] = version
}

const staging = path.join(root, 'staging')
const daemonDir = path.join(staging, 'daemon')
const nodeDir = path.join(staging, 'node')
rmSync(staging, { recursive: true, force: true })
mkdirSync(daemonDir, { recursive: true })
mkdirSync(nodeDir, { recursive: true })

const dist = path.join(root, 'dist')
if (!existsSync(path.join(dist, 'cli.js'))) {
  throw new Error('no dist/cli.js — run `pnpm build` first')
}
cpSync(dist, path.join(daemonDir, 'dist'), { recursive: true })

writeFileSync(
  path.join(daemonDir, 'package.json'),
  JSON.stringify({
    name: 'yaac-daemon', version: pkg.version, private: true,
    type: 'module', dependencies: deps,
  }, null, 2),
)
console.log('[stage] installing daemon production deps…')
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: daemonDir, stdio: 'inherit',
})

// Bundle the Node this script runs on. Run under the pinned version so the
// shipped runtime matches .nvmrc.
const pinned = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '')
const pinnedMajor = pinned.split('.')[0]
const runMajor = process.version.replace(/^v/, '').split('.')[0]
if (pinnedMajor !== runMajor) {
  console.warn(`[stage] node ${process.version} != pinned v${pinned} — run \`nvm use\` and re-stage`)
}
cpSync(process.execPath, path.join(nodeDir, 'node'))
chmodSync(path.join(nodeDir, 'node'), 0o755)

console.log('[stage] done → staging/daemon (dist + node_modules), staging/node/node')
