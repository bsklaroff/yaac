import { defineConfig } from 'tsup'

export default defineConfig([{
  // The main process, and the auth daemon it runs in a utilityProcess.
  entry: { 'main': 'src/main.ts', 'auth-daemon': 'src/auth-daemon.ts' },
  format: 'esm',
  platform: 'node',
  clean: true,
  // Bundle everything except electron and node-pty's native module:
  // workspace source can't run under raw node, since its imports maps use
  // output-form .js targets.
  external: ['electron', '@lydell/node-pty'],
  noExternal: [/^(?!electron$|@lydell\/node-pty$)/],
  // The installed .app lives outside the repo, so shared's PACKAGE_ROOT must
  // take its bundled branch; the dev fallback throws when no
  // pnpm-workspace.yaml is found. Same define as the root config.
  env: {
    YAAC_BUNDLED: 'true',
  },
  // ws is CJS and calls require() for node built-ins and optional native
  // modules, so the ESM bundle needs a real `require`. The import is aliased
  // because esbuild can't rename around banner text, and a bare
  // `createRequire` would collide with source modules that import it.
  banner: {
    js: "import { createRequire as __banner_createRequire } from 'node:module'; const require = __banner_createRequire(import.meta.url);",
  },
}, {
  // A sandboxed preload must be CommonJS, and the package is type:module,
  // hence .cjs. `clean` is off so it keeps the bundles built above.
  entry: { preload: 'src/preload.ts' },
  format: 'cjs',
  platform: 'node',
  outExtension: () => ({ js: '.cjs' }),
  clean: false,
  external: ['electron'],
}])
