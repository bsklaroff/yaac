import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@test': path.resolve(__dirname, 'test'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    // E2e beforeAll hooks start containers on cold caches, which exceeds the
    // vitest default of 10s. Match testTimeout so hook-bound container setup
    // doesn't fail spuriously before the first test runs.
    hookTimeout: 120_000,
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
  },
})
