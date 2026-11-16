import fs from 'node:fs/promises'
import { defineConfig } from 'tsup'

/**
 * Self-contained programs the server starts, built after the CLI into the
 * same `dist/`. Each bundles its npm deps too, since nothing beside it has
 * a node_modules to resolve from.
 */
export default defineConfig([
  {
    // The git reader `bundleCheckout` starts (packages/server/src/domain/
    // git/peer-bundle.ts). An `.mjs` needs no package.json lookup, so its
    // permission sandbox can grant reads of this one file.
    entry: { 'git-peer-reader': 'packages/server/src/domain/git/peer-reader.ts' },
    format: 'esm',
    target: 'node22',
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
    clean: false,
    noExternal: [/.*/],
    // isomorphic-git's CommonJS dependencies call `require`.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  },
  {
    // `yaac-files`, the file editor's helper inside a k8s workspace
    // (packages/server/src/domain/workspaces/tree-helper.ts), staged with
    // the other workspace-bin helpers, which are named without an
    // extension; tsup always adds one, so it is dropped once built. Node
    // runs such a file as ESM by its syntax, or by this repo's package.json
    // where one is above it.
    entry: { 'workspace-bin/yaac-files': 'packages/server/src/domain/workspaces/tree-helper.ts' },
    format: 'esm',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    noExternal: [/.*/],
    banner: { js: '#!/usr/bin/env node' },
    onSuccess: () => fs.rename('dist/workspace-bin/yaac-files.js', 'dist/workspace-bin/yaac-files'),
  },
  {
    // `yaac-disk`, the per-node disk pod's program (packages/server/src/
    // drivers/k8s/cluster/disk-probe.ts), which runs in the server image.
    entry: { 'yaac-disk': 'packages/server/src/drivers/k8s/cluster/disk-probe.ts' },
    format: 'esm',
    target: 'node22',
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
    clean: false,
    noExternal: [/.*/],
  },
  {
    // `yaac-tree`, the tree container's program (packages/server/src/
    // drivers/k8s/workspaces/tree/script.ts), shipped the same way.
    entry: { 'workspace-bin/yaac-tree': 'packages/server/src/drivers/k8s/workspaces/tree/script.ts' },
    format: 'esm',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    noExternal: [/.*/],
    banner: { js: '#!/usr/bin/env node' },
    onSuccess: () => fs.rename('dist/workspace-bin/yaac-tree.js', 'dist/workspace-bin/yaac-tree'),
  },
])
