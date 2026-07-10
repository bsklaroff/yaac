import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  // The base tsconfig doesn't set "jsx" for test transform, so tell esbuild
  // directly — needed for any .tsx tests run by inline projects here.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@test': path.resolve(__dirname, 'test'),
      '@proxy': path.resolve(__dirname, 'k8s/proxy'),
    },
  },
  test: {
    testTimeout: 120_000,
    // E2e beforeAll/beforeEach hooks start containers on cold caches AND
    // wait their turn on the cross-worker server mutex — with many
    // workers queued, a waiter can sit well past vitest's 10s default.
    // Raised to 600s so queued hooks don't false-fail as flakes.
    hookTimeout: 600_000,
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    projects: [
      // Frontend unit tests own their config (jsdom + testing-library resolve
      // from apps/frontend, where those deps live).
      'apps/frontend/vitest.config.ts',
      {
        extends: true,
        test: {
          name: 'unit:core',
          include: ['test/unit/**/*.test.{ts,tsx}'],
          // unit-setup.ts strips the nested-session env (YAAC_NESTED,
          // YAAC_DATA_DIR, YAAC_K8S_REGISTRY) so unit assertions stay
          // deterministic when the suite runs inside a yaac session. Listed
          // alongside the shared setup since a project's setupFiles replace
          // the inherited root value rather than extending it.
          setupFiles: ['test/setup.ts', 'test/unit-setup.ts'],
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
