/**
 * Puts a wrapper in front of omp's release binary (the pinned release, see
 * `AGENT_CLIS.omp`) and unpacks the binary's native add-on beside it.
 *
 *   node omp-homes.js <prefix>/lib/omp/omp
 *
 * Run by `dockerfiles/Dockerfile.tools` and by the containerless driver's
 * install, right after the binary is downloaded. The wrapper goes at
 * `<prefix>/bin/omp`. Bump the patch's `revision` in
 * `@yaac/shared/tool-install` whenever the wrapper changes.
 *
 * omp reads pi's home variables, `PI_CODING_AGENT_DIR` and
 * `PI_CODING_AGENT_SESSION_DIR`, which a yaac workspace sets to pi's homes.
 * The workspace names omp's agent dir `YAAC_OMP_AGENT_DIR`, and the wrapper
 * hands it to omp under pi's name and drops pi's session dir, so omp keeps
 * its logs under its agent dir, the one place its acp server looks for a
 * conversation to load. Outside a workspace it changes nothing.
 *
 * The binary embeds its native add-on (about 140 MB per CPU variant) and
 * unpacks it into `PI_NATIVES_DIR` (default `~/.omp/natives`, the project's
 * shared omp home in a pod) when it first needs it, which takes seconds.
 * The wrapper points that variable at `natives/` beside the binary, and
 * this script fills it with each variant the build embeds. A pod runs at
 * another uid than the build, and omp then cannot unpack into the image's
 * dir (it sets the dir's times, which only the owner may), so an x64 node
 * whose CPU picks the other variant needs that one already there
 * (docs/arbitrary-uid-images.md). omp also downloads uncommon tree-sitter
 * grammars into `natives/grammars` on demand, which is why the dir stays
 * group-writable.
 *
 * Whatever runs `omp` from PATH gets the wrapper: yaac's launches, acpd, a
 * terminal, and omp's own subprocesses and subagents, which inherit what it
 * exported. Running the binary directly bypasses it and gets pi's homes,
 * and so would anything after an `omp update`, which replaces the `omp` on
 * PATH (the wrapper) with a downloaded binary; yaac's launches turn
 * auto-update off.
 *
 * The wrapper finds omp relative to itself, since the containerless install
 * renames the prefix it runs in once the patch is done.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The wrapper's text, for a `bin/omp` beside the `lib/omp/` that holds
 *  the binary. */
export const OMP_WRAPPER = `#!/bin/sh
# Written by yaac (dockerfiles/agent-patches/omp-homes.js): hands omp the
# agent dir a yaac workspace names for it under pi's variable, which omp
# reads, drops pi's session dir, and points omp at the native add-on
# unpacked beside it.
[ -z "\${YAAC_OMP_AGENT_DIR:-}" ] || export PI_CODING_AGENT_DIR="$YAAC_OMP_AGENT_DIR"
[ -z "\${YAAC_OMP_AGENT_DIR:-}" ] || unset PI_CODING_AGENT_SESSION_DIR
case $0 in /*) omp=\${0%/*}/../lib/omp ;; *) omp=$PWD/\${0%/*}/../lib/omp ;; esac
export PI_NATIVES_DIR="$omp/natives"
exec "$omp/omp" "$@"
`

/**
 * Write the wrapper over `<prefix>/bin/omp` for the binary at
 * `<prefix>/lib/omp/omp`, and unpack the add-on through it. Everything is
 * group-writable like the rest of the image (docs/arbitrary-uid-images.md).
 * `--help` is the cheapest command that loads the add-on; `--version` does
 * not. `PI_NATIVE_VARIANT` picks the x64 variant and means nothing on arm64.
 * omp unpacks a variant before loading it, so a forced run that cannot
 * load it (the modern one without AVX2) still unpacks it; the last run,
 * with the variant this CPU picks, must succeed. On x64 the baseline
 * variant must then be there: every x64 CPU loads it, and omp falls back
 * to it. Only the linux glibc build also embeds a modern one.
 */
export function installOmpWrapper(binary) {
  const bin = path.join(path.dirname(binary), '..', '..', 'bin', 'omp')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.rmSync(bin, { force: true })
  fs.writeFileSync(bin, OMP_WRAPPER, { mode: 0o775 })
  const { PI_NATIVE_VARIANT: _, ...env } = process.env
  for (const variant of ['modern', 'baseline']) {
    try {
      execFileSync(bin, ['--help'], { env: { ...env, PI_NATIVE_VARIANT: variant }, stdio: 'ignore' })
    } catch {
      // Checked below.
    }
  }
  try {
    execFileSync(bin, ['--help'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    throw new Error(`omp --help failed: ${String(err.stderr ?? '').trim() || err.message}`)
  }
  const natives = path.join(path.dirname(binary), 'natives')
  const files = fs.existsSync(natives) ? fs.readdirSync(natives, { recursive: true, encoding: 'utf8' }) : []
  const suffix = process.arch === 'x64' ? '-baseline.node' : '.node'
  if (!files.some((f) => f.endsWith(suffix))) throw new Error(`omp unpacked no *${suffix} native add-on into ${natives}`)
  for (const file of ['', ...files].map((f) => path.join(natives, f))) {
    fs.chmodSync(file, fs.statSync(file).mode | 0o020)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const binary = process.argv[2]
  if (binary === undefined || !binary.endsWith(`${path.sep}lib${path.sep}omp${path.sep}omp`)) {
    console.error(`usage: node ${process.argv[1]} <prefix>/lib/omp/omp`)
    process.exit(2)
  }
  installOmpWrapper(path.resolve(binary))
}
