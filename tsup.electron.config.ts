import { defineConfig } from 'tsup'

/**
 * Builds the Electron main process to `dist-electron/main.mjs`. Separate from
 * the CLI build (tsup.config.ts) because it targets Electron's main process,
 * not the `#!/usr/bin/env node` CLI. Output is ESM (Electron ≥28 loads an ESM
 * main) so `import.meta.url` in shared modules (e.g. src/shared/paths.ts)
 * resolves correctly — a CJS bundle would empty it and crash on load. The
 * daemon's native deps (node-pty) are never imported here — the daemon runs
 * as a separate Node child — so this bundle stays free of native modules.
 */
export default defineConfig({
  entry: { main: 'src/electron/main.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  outDir: 'dist-electron',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  external: ['electron'],
  esbuildOptions(options) {
    options.alias = { '@': './src', '@test': './test' }
  },
})
