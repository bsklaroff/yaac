import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src',
  // `tauri dev` multiplexes this vite process's output with its own.
  clearScreen: false,
  server: {
    // 1420 is apps/frontend's dev server; strictPort keeps tauri.conf.json's
    // devUrl honest instead of silently drifting to the next free port.
    port: 1430,
    strictPort: true,
  },
  build: {
    // The launcher page tauri embeds (frontendDist: ../dist). The SPA itself
    // is never bundled here — the launcher navigates to the server origin,
    // which serves the same assets as the webapp.
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
