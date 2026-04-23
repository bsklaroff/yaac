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
    // E2e beforeAll/beforeEach hooks start containers on cold caches AND
    // wait their turn on the cross-worker daemon mutex — with many
    // workers queued, a waiter can sit well past vitest's 10s default.
    // Raised to 600s so queued hooks don't false-fail as flakes.
    hookTimeout: 600_000,
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
  },
})
