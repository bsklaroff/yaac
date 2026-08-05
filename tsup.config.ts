import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'packages/cli/src/cli.ts' },
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Consumed (and then removed) by scripts/check-cli-externals.ts, which
  // fails the build when the bundle imports an external package missing
  // from the root manifest's dependencies.
  metafile: true,
  banner: { js: '#!/usr/bin/env node' },
  env: {
    YAAC_BUNDLED: 'true',
  },
  // Bundle the workspace packages (@yaac/cli, @yaac/server, @yaac/shared,
  // @yaac/auth-daemon) into dist/; runtime npm deps stay external (they're in
  // the published package's dependencies). The CLI's deliberate `import()`
  // deferrals (see packages/cli/src/cli.ts) make esbuild emit sibling chunks
  // next to the dist/cli.js entry, which is what keeps the server graph —
  // and the 2.2s @kubernetes/client-node load — off `yaac --version`. The
  // whole dist dir is published, so the chunks ship with the entry.
  noExternal: [/^@yaac\//],
})
