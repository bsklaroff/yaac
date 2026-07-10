import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The base tsconfig doesn't set "jsx" for test transform, so tell esbuild
  // directly — needed for any .tsx tests run by inline projects here.
  esbuild: { jsx: 'automatic' },
  test: {
    testTimeout: 120_000,
    // E2e beforeAll/beforeEach hooks start containers on cold caches AND
    // wait their turn on the cross-worker server mutex — with many
    // workers queued, a waiter can sit well past vitest's 10s default.
    // Raised to 600s so queued hooks don't false-fail as flakes.
    hookTimeout: 600_000,
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['@yaac/test-utils/vitest-setup'],
    projects: [
      // Per-package unit projects own their config (and, for frontend/proxy,
      // their own module resolution). Names are `unit:<pkg>`.
      'apps/frontend/vitest.config.ts',
      'apps/cli/vitest.config.ts',
      'packages/server/vitest.config.ts',
      'packages/shared/vitest.config.ts',
      'packages/auth-daemon/vitest.config.ts',
      'packages/test-utils/vitest.config.ts',
      'k8s/proxy/vitest.config.ts',
      // api + e2e live in the root test/ tree (inherently cross-package).
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
          // Serialize e2e files: the cross-worker server mutex already
          // funnels server-backed work through one at a time, so worker
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
