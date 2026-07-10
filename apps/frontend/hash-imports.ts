import path from 'node:path'
import { existsSync } from 'node:fs'
import type { Plugin } from 'vite'

/**
 * Resolve the frontend's `#…` subpath imports: Vite doesn't fall through the
 * package.json `imports` array (./src/*.ts then ./src/*.tsx), so rewrite `#`
 * to src/ and let Vite's own extension probing find .ts / .tsx. tsc/eslint
 * use the package.json imports map instead (no `#*` tsconfig paths).
 *
 * A resolveId plugin rather than a resolve.alias: an alias applies to every
 * module in the graph, and other workspace packages use `#…` for their own
 * subpath imports — the test setup files pull @yaac/shared (whose modules
 * import `#env`, `#paths`, …) into the frontend project's graph, so the
 * rewrite must apply only to importers inside apps/frontend.
 *
 * Shared by vite.config.ts (dev/build) and the root vitest config's
 * unit:frontend project so the two resolvers can't drift. Anchored on the
 * pnpm-workspace.yaml marker rather than import.meta.url: both consumers
 * load this file through config bundlers/runners that rewrite module URLs
 * (vitest's module runner root-relativizes them), and neither loader can
 * resolve @yaac/shared to reuse findRepoRoot. cwd is the repo root (vitest)
 * or apps/frontend (vite dev/build) — both under the marker.
 */
function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('Could not find pnpm-workspace.yaml')
    dir = parent
  }
  return dir
}

export function frontendHashImports(): Plugin {
  const frontendDir = path.join(repoRoot(), 'apps', 'frontend')
  const srcDir = path.join(frontendDir, 'src')
  return {
    name: 'yaac:frontend-hash-imports',
    // Before Vite's own resolver, which would resolve `#…` through the
    // imports map and stop at its first (.ts-only) target.
    enforce: 'pre',
    resolveId(source, importer, options) {
      if (!source.startsWith('#') || importer === undefined) return null
      // Importer ids are absolute fs paths, but module runners can
      // root-relativize them — match on the repo-relative segment.
      if (!importer.startsWith(frontendDir + path.sep)
        && !importer.includes(`${path.sep}apps${path.sep}frontend${path.sep}`)) return null
      return this.resolve(path.join(srcDir, source.slice(1)), importer, { ...options, skipSelf: true })
    },
  }
}
