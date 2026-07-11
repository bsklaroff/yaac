import { defineConfig } from 'tsup'

/**
 * Builds the Electron preload to `dist-electron/preload.cjs`, alongside the
 * main bundle. CJS (not ESM like main) because the preload runs sandboxed,
 * where only a CommonJS script may use contextBridge/ipcRenderer. `clean` is
 * off so it doesn't wipe main.mjs — run this after tsup.electron.config.ts.
 */
export default defineConfig({
  entry: { preload: 'src/electron/preload.ts' },
  format: 'cjs',
  target: 'node22',
  platform: 'node',
  outDir: 'dist-electron',
  outExtension: () => ({ js: '.cjs' }),
  clean: false,
  external: ['electron'],
})
