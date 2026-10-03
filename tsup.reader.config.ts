import { defineConfig } from 'tsup'

/**
 * The git reader `bundleCheckout` starts (packages/server/src/domain/git/
 * peer-bundle.ts), built after the CLI into the same `dist/`. It bundles its
 * npm deps too, so its permission sandbox can grant reads of this one file:
 * an `.mjs` needs no package.json lookup, and nothing resolves from
 * node_modules.
 */
export default defineConfig({
  entry: { 'git-peer-reader': 'packages/server/src/domain/git/peer-reader.ts' },
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  clean: false,
  noExternal: [/.*/],
  // isomorphic-git's CommonJS dependencies call `require`.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
