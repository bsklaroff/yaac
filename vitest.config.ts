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
    testTimeout: 120_000,
    // E2e beforeAll/beforeEach hooks start containers on cold caches AND
    // wait their turn on the cross-worker daemon mutex — with many
    // workers queued, a waiter can sit well past vitest's 10s default.
    // Raised to 600s so queued hooks don't false-fail as flakes.
    hookTimeout: 600_000,
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          // Ordered before capped projects so fast unit feedback lands
          // first. Explicit groupOrder is required once projects diverge
          // on maxWorkers; vitest refuses to pick an order itself.
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['test/api/**/*.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: [
            'test/e2e/**/*.test.ts',
            'test/e2e-cli/**/*.test.ts',
          ],
          // Serialize e2e files: the cross-worker daemon mutex already
          // funnels daemon-backed work through one at a time, so worker
          // parallelism mostly buys queue depth on the shared podman
          // socket. Running one file at a time eliminates load-induced
          // timeouts on lock waits, network creation, and container start.
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
