/**
 * Puts a wrapper in place of omp's `bin/omp` (the pinned release, see
 * `AGENT_CLIS.omp`).
 *
 *   node omp-homes.js <omp>/dist/cli.js
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after npm installs omp, with the path of the file npm
 * links `bin/omp` to. Bump the patch's `revision` in
 * `@yaac/shared/tool-install` whenever the wrapper changes.
 *
 * omp reads pi's home variables, `PI_CODING_AGENT_DIR` and
 * `PI_CODING_AGENT_SESSION_DIR`, which a yaac workspace sets to pi's homes.
 * The workspace names omp's agent dir `YAAC_OMP_AGENT_DIR`, and the wrapper
 * hands it to omp under pi's name and drops pi's session dir, so omp keeps
 * its logs under its agent dir, the one place its acp server looks for a
 * conversation to load. Outside a workspace it changes nothing.
 *
 * Whatever runs `omp` from PATH gets it: yaac's launches, acpd, a terminal,
 * and omp's own subprocesses and subagents, which inherit what it exported.
 * Running omp's `cli.js` directly (`bun …/dist/cli.js`, `npx` or `bunx` of
 * the package) bypasses it and gets pi's homes, and so would an `omp
 * update`, which relinks `bin/omp`; yaac's launches turn auto-update off.
 *
 * The wrapper finds omp relative to itself, since the containerless install
 * renames the npm prefix it runs in once the patch is done.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The wrapper's text, for a `bin/omp` that reaches omp's `cli.js` at
 *  `relativeCli`. */
export function ompWrapper(relativeCli) {
  return `#!/bin/sh
# Written by yaac (dockerfiles/agent-patches/omp-homes.js): hands omp the
# agent dir a yaac workspace names for it under pi's variable, which omp
# reads, and drops pi's session dir.
[ -z "\${YAAC_OMP_AGENT_DIR:-}" ] || export PI_CODING_AGENT_DIR="$YAAC_OMP_AGENT_DIR"
[ -z "\${YAAC_OMP_AGENT_DIR:-}" ] || unset PI_CODING_AGENT_SESSION_DIR
exec "\${0%/*}/${relativeCli}" "$@"
`
}

/** Replace the npm prefix's `bin/omp` link to `cli` with the wrapper. */
export function installOmpWrapper(cli) {
  const nodeModules = cli.slice(0, cli.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length)
  const bin = path.join(path.dirname(path.dirname(nodeModules)), 'bin', 'omp')
  fs.rmSync(bin, { force: true })
  fs.writeFileSync(bin, ompWrapper(path.relative(path.dirname(bin), cli)), { mode: 0o755 })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cli = process.argv[2]
  if (cli === undefined || !cli.includes(`${path.sep}node_modules${path.sep}`)) {
    console.error(`usage: node ${process.argv[1]} <prefix>/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`)
    process.exit(2)
  }
  installOmpWrapper(path.resolve(cli))
}
