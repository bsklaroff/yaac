#!/usr/bin/env node
/**
 * The entry of a one-file adapter in the workspace image:
 * dockerfiles/Dockerfile.tools copies it beside each `yaac-bundle.mjs`, and
 * beside codex-acp's own file with the import below renamed to it, and
 * points the adapter's bin link at it.
 *
 * It turns on Node's compile cache for the adapter alone, since a variable
 * would reach every node the agent runs. The cache is a folder beside this
 * file. For a bundle the image build has filled it
 * (`bake-compile-cache.mjs`), so an adapter's first start in a pod does not
 * compile the bundle.
 *
 * Node keeps one cache folder per uid, named `<node build>-<uid>`, and a pod
 * runs as the install's uid, not the build's (docs/arbitrary-uid-images.md).
 * So the build's folder is linked under this uid's name first. Where the
 * link cannot be made, or the build ran on a CPU whose V8 names its caches
 * differently, Node compiles as usual and writes a cache of its own, which
 * later starts in the pod read.
 */

import fs from 'node:fs'
import module from 'node:module'
import { fileURLToPath } from 'node:url'

const cache = fileURLToPath(new URL('./yaac-compile-cache/', import.meta.url))

try {
  const names = fs.readdirSync(cache)
  for (const name of names) {
    const mine = name.replace(/-\d+$/, `-${process.getuid()}`)
    if (!names.includes(mine)) fs.symlinkSync(name, cache + mine)
  }
} catch { /* no folder, or not ours to write: Node compiles as usual */ }

module.enableCompileCache(cache)
await import('./yaac-bundle.mjs')
module.flushCompileCache()
