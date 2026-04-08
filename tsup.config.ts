import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  env: {
    YAAC_BUNDLED: 'true',
  },
  esbuildOptions(options) {
    options.alias = { '@': './src', '@test': './test' }
  },
})
