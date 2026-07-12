import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  clean: true,
  // Bundle everything (workspace source can't run under raw node — its
  // imports/exports maps use output-form .js targets) EXCEPT electron,
  // which is a runtime built-in of the electron binary.
  external: ['electron'],
  noExternal: [/^(?!electron$)/],
  // ws is CJS: its internal require('events')/require('net') — and the
  // try/catch'd optional-native requires (bufferutil, utf-8-validate, which
  // fail into the pure-JS fallback) — need a real `require` in the ESM
  // bundle. esbuild doesn't inject one, so provide it.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
