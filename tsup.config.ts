import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'packages/cli/src/cli.ts' },
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Read (then deleted) by scripts/check-cli-externals.ts, which fails the
  // build if the bundle imports a package missing from the root manifest.
  metafile: true,
  banner: { js: '#!/usr/bin/env node' },
  env: {
    YAAC_BUNDLED: 'true',
  },
  // Bundle the @yaac/* workspace packages; npm deps stay external and
  // resolve from the published package's dependencies. The CLI's dynamic
  // `import()`s (see packages/cli/src/cli.ts) become separate chunks in
  // dist/, which keeps the server graph and the slow @kubernetes/client-node
  // load off fast commands like `yaac --version`.
  noExternal: [/^@yaac\//],
  // Keep `node:` on builtin imports. tsup strips it by default, which breaks
  // builtins that exist only under the prefix (`node:sqlite`).
  removeNodeProtocol: false,
})
