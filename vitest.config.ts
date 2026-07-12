import { defineConfig } from 'vitest/config'

// Every project is inline (`extends: true`) so the shared test policy —
// timeouts, isolation setupFiles, ordering — lives in exactly one file.
// File-referenced project configs would NOT inherit these root options;
// when the packages split briefly used them, three projects silently lost
// the setup hygiene below.
//
// vitest-setup strips inherited git env and points the default data dir at
// a temp path so no test can touch the developer's real repo or ~/.yaac;
// unit-setup additionally strips the nested-session env (YAAC_NESTED,
// YAAC_DATA_DIR, YAAC_K8S_REGISTRY) so unit runs are identical on a host
// and inside a yaac session. E2e keeps the nested env: the real CLI under
// test genuinely needs it.
const SETUP = ['@yaac/test-utils/vitest-setup']
const UNIT_SETUP = [...SETUP, '@yaac/test-utils/unit-setup']

function unitProject(pkgDir: string, extra: object = {}) {
  return {
    extends: true as const,
    ...extra,
    test: {
      name: `unit:${pkgDir.split('/').pop()!}`,
      include: [`${pkgDir}/test/**/*.test.{ts,tsx}`],
      setupFiles: UNIT_SETUP,
      sequence: { groupOrder: 0 },
    },
  }
}

export default defineConfig({
  test: {
    testTimeout: 120_000,
    // E2e beforeAll/beforeEach hooks start containers on cold caches AND
    // wait their turn on the cross-worker server mutex — with many
    // workers queued, a waiter can sit well past vitest's 10s default.
    // Raised to 600s so queued hooks don't false-fail as flakes.
    hookTimeout: 600_000,
    projects: [
      // Co-located per-package unit tests. Names are `unit:<pkg>`.
      unitProject('apps/cli'),
      // .tsx component tests: transform JSX via esbuild (no react plugin
      // needed for tests); jsdom is selected per-file via
      // `// @vitest-environment jsdom`.
      unitProject('apps/frontend', {
        esbuild: { jsx: 'automatic' },
      }),
      unitProject('packages/server'),
      unitProject('packages/shared'),
      unitProject('packages/auth-daemon'),
      unitProject('packages/test-utils'),
      // Self-imports (yaac-proxy-sidecar/<mod>) resolve via the package's
      // own exports map — no alias needed.
      unitProject('k8s/proxy'),
      // api + e2e live in the root test/ tree (inherently cross-package).
      {
        extends: true,
        test: {
          name: 'api',
          include: ['test/api/**/*.test.ts'],
          setupFiles: SETUP,
          // Image pre-builds live on the api/e2e projects, not the root:
          // `extends: true` would propagate a root globalSetup into every
          // unit project (each of which runs it through its own vite
          // server), and unit tests must never touch podman anyway.
          globalSetup: ['test/global-setup.ts'],
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
          setupFiles: SETUP,
          globalSetup: ['test/global-setup.ts'],
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
