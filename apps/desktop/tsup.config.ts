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
  // The desktop main is always a shipped bundle (even `dev` runs the tsup
  // output), and the installed .app lives outside the repo — so shared's
  // PACKAGE_ROOT must take its bundled branch (__dirname) rather than the
  // dev fallback findRepoRoot(), which throws at module load when no
  // pnpm-workspace.yaml exists up the tree. Same define as the root config.
  env: {
    YAAC_BUNDLED: 'true',
  },
  // ws is CJS: its internal require('events')/require('net') — and the
  // try/catch'd optional-native requires (bufferutil, utf-8-validate, which
  // fail into the pure-JS fallback) — need a real `require` in the ESM
  // bundle. esbuild doesn't inject one, so provide it. The import is
  // aliased because the banner is raw text prepended after bundling:
  // esbuild can't rename around it, so a bare `createRequire` collides
  // with any source module whose own `import { createRequire }` from
  // node:module is preserved in the output (e.g. shared/auth-daemon).
  banner: {
    js: "import { createRequire as __banner_createRequire } from 'node:module'; const require = __banner_createRequire(import.meta.url);",
  },
})
