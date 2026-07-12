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
})
