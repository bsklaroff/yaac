// node-pty's published prebuilds ship `spawn-helper` (the macOS/Linux PTY
// fork helper) without the executable bit, so `pty.fork` fails with
// "posix_spawnp failed". Restore +x after every install. No-op when
// node-pty isn't installed or on platforms without the helper (Windows).
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

let entry
try {
  entry = require.resolve('node-pty')
} catch {
  process.exit(0) // node-pty not installed — nothing to do
}

// entry is .../node-pty/lib/index.js → walk up to the package root
let pkgDir = path.dirname(entry)
if (path.basename(pkgDir) === 'lib') pkgDir = path.dirname(pkgDir)

const candidates = []
const prebuilds = path.join(pkgDir, 'prebuilds')
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    candidates.push(path.join(prebuilds, dir, 'spawn-helper'))
  }
}
candidates.push(path.join(pkgDir, 'build', 'Release', 'spawn-helper'))

let fixed = 0
for (const file of candidates) {
  try {
    if (fs.existsSync(file)) {
      fs.chmodSync(file, 0o755)
      fixed++
    }
  } catch {
    // best-effort; ignore
  }
}

if (fixed > 0) console.log(`[fix-node-pty-perms] +x on ${fixed} spawn-helper binary(ies)`)
