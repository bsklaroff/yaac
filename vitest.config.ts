import { configDefaults, defineConfig } from 'vitest/config'
import E2eSequencer from './test/support/e2e-sequencer'

// Every project is inline (`extends: true`) so shared test policy
// (timeouts, setupFiles, ordering) lives in this one file. Separate
// per-project config files would not inherit these root options.
//
// vitest-setup strips inherited git env and points the default data dir at
// a temp path, so no test touches the developer's repo or ~/.yaac.
// unit-setup also strips an ambient YAAC_DATA_DIR so unit runs behave the
// same on a host and in a yaac workspace.
// These are file paths, not @yaac/test-utils specifiers: vitest resolves
// setupFiles with plain Node semantics, which can't map the exports map's
// .js targets to .ts sources.
const SETUP = ['./packages/test-utils/src/vitest-setup.ts']
const UNIT_SETUP = [...SETUP, './packages/test-utils/src/unit-setup.ts']
// Stubs @kubernetes/client-node, which takes ~2.8s to load in each test file
// that reaches #drivers/k8s/substrate. Not used for k8s/proxy and k8s/netd,
// which build real KubeConfigs and informers, or for e2e.
const K8S_STUB_SETUP = './packages/test-utils/src/k8s-stub-setup.ts'
// Builds the migrated-database dump that new databases load instead of
// replaying every migration, for the projects whose tests open one.
const DB_SNAPSHOT_SETUP = './packages/test-utils/src/db-snapshot.ts'
// e2e only: deletes each file's test namespace when the file finishes, so
// finished files' netd DaemonSets don't pile up on the single node.
const CLUSTER_SETUP = [...SETUP, './test/support/cluster-setup.ts']
// api-k8s only: the real k8s driver over the stubbed client, in place of
// the composition root. The stub must load first.
const API_K8S_SETUP = [...UNIT_SETUP, K8S_STUB_SETUP, './test/support/api-k8s-setup.ts']
// api-containerless only: registers the real containerless driver in place
// of the composition root.
const CONTAINERLESS_SETUP = [...SETUP, './test/support/containerless-setup.ts']
/**
 * The api files that run under the containerless driver: its column of the
 * route matrix, plus files that drive the Hono app in process over routes no
 * driver feature gates. The rest need the k8s driver (`routes-k8s`) or hit
 * routes that answer `NOT_SUPPORTED` without it (`write-routes`, the image
 * routes).
 */
const CONTAINERLESS_API = [
  'test/api/routes-containerless.test.ts',
  'test/api/in-process-routes.test.ts',
  'test/api/server.test.ts',
  'test/api/identity-flow.test.ts',
  'test/api/transcript-route.test.ts',
  'test/api/token-listener.test.ts',
  // Driver-neutral: guards WebSocket compression pass-through, which a
  // dependency bump could break for every install, so it also runs where
  // there is no cluster.
  'test/api/websocket-compression.test.ts',
]

/** The k8s e2e files, run against the kind rig. */
const E2E_FILES = ['test/e2e/**/*.test.ts', 'test/e2e-cli/**/*.test.ts']

/** JSON record of the last run; `pnpm test:failures`
 *  (scripts/test-failures.ts) prints the failures from it. */
const TEST_FAILURES_FILE = './.vitest-last-run.json'

function unitProject(pkgDir: string, extra: object = {}) {
  const realK8sClient = pkgDir.startsWith('k8s/')
  return {
    extends: true as const,
    test: {
      name: `unit:${pkgDir.split('/').pop()!}`,
      include: [`${pkgDir}/test/**/*.test.{ts,tsx}`],
      setupFiles: realK8sClient ? UNIT_SETUP : [...UNIT_SETUP, K8S_STUB_SETUP],
      sequence: { groupOrder: 0 },
      ...extra,
    },
  }
}

export default defineConfig({
  test: {
    // Measured, not gated (no thresholds). It shows whether a sealed
    // folder's internals are still exercised through its barrel.
    coverage: {
      provider: 'v8',
      include: ['packages/server/src/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
    },
    testTimeout: 120_000,
    // E2e hooks start containers on cold caches and wait on the cross-worker
    // server mutex, which can take far longer than vitest's 10s default.
    hookTimeout: 600_000,
    // Orders the e2e project's files for its two workers.
    sequence: { sequencer: E2eSequencer },
    // Also write results to a file so failures can be recovered after the
    // console output is truncated, without re-running. Overwritten per run,
    // gitignored.
    reporters: ['default', ['json', { outputFile: TEST_FAILURES_FILE }]],
    projects: [
      // Co-located per-package unit tests. Names are `unit:<pkg>`.
      unitProject('packages/cli'),
      // Oxc transforms JSX, so no react plugin is needed. The SPA only runs
      // in a browser, so every file gets jsdom, plus the stand-ins in
      // test/setup.ts for the browser APIs jsdom lacks.
      {
        extends: true as const,
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'unit:frontend',
          include: ['packages/frontend/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // One jsdom per worker instead of one per file, which costs more
          // than the tests themselves; each file still gets its own VM
          // context. Forks rather than threads, where a test's change of
          // `process.env.TZ` changes no clock.
          pool: 'vmForks',
          unstubGlobals: true,
          setupFiles: [...UNIT_SETUP, './packages/frontend/test/setup.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      unitProject('packages/desktop'),
      unitProject('packages/server', { globalSetup: [DB_SNAPSHOT_SETUP] }),
      unitProject('packages/shared'),
      unitProject('packages/auth-daemon'),
      unitProject('packages/test-utils'),
      unitProject('test/support'),
      unitProject('k8s/proxy'),
      unitProject('k8s/netd'),
      unitProject('k8s/tailgate'),
      // The agent patches are plain JS shipped in dockerfiles/ and outside
      // the root tsconfig, so these tests are their only check. The daemons
      // (daemons/) are Go, tested by `pnpm test:daemons`.
      unitProject('dockerfiles/agent-patches'),
      // api + e2e live in the root test/ tree. The api tier has one project
      // per driver, matching the route matrix's two columns. Neither needs
      // a cluster: the api files build the app in process, and api-k8s runs
      // the k8s driver over the client stub the unit projects use, whose
      // calls the apiserver project checks against a real API server.
      {
        extends: true,
        test: {
          name: 'api-k8s',
          include: ['test/api/**/*.test.ts'],
          // `exclude` replaces the defaults, so spread them back in.
          exclude: [...configDefaults.exclude, ...CONTAINERLESS_API],
          setupFiles: API_K8S_SETUP,
          // A fresh data dir per test, as write-routes makes, would replay
          // every migration without the dump and the shared database.
          globalSetup: [DB_SNAPSHOT_SETUP],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'api-containerless',
          include: [...CONTAINERLESS_API],
          setupFiles: CONTAINERLESS_SETUP,
          // Makes `spawnYaacServer` start a host process instead of deploying
          // the k8s server into a cluster (docs/server-in-cluster.md).
          env: { YAAC_DRIVER: 'containerless' },
          // Builds only the CLI (`dist-test/`), which spawning a server needs.
          globalSetup: ['test/global-setup-containerless.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      // The k8s driver's object calls against a real kube-apiserver and
      // etcd from pinned release binaries: no cluster, so it runs anywhere,
      // including a yaac workspace.
      {
        extends: true,
        test: {
          name: 'apiserver',
          include: ['test/apiserver/**/*.test.ts'],
          setupFiles: SETUP,
          globalSetup: ['test/apiserver/global-setup.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      // The containerless tier: the CLI against a server that runs
      // workspaces as tmux sessions on this host, and every command that
      // touches no workspace runtime, which a second run against a cluster
      // would only repeat. No cluster or images, so the global setup only
      // builds the CLI.
      {
        extends: true,
        test: {
          name: 'e2e-containerless',
          include: ['test/e2e-containerless/**/*.test.ts'],
          // As in api-containerless: spawn a host server.
          env: { YAAC_DRIVER: 'containerless' },
          // Not cluster-setup: there is no namespace to drop, and it would
          // load the kubernetes client into every worker.
          setupFiles: SETUP,
          globalSetup: ['test/global-setup-containerless.ts'],
          // Each file runs its own host server on its own data dir, so
          // files run side by side. Four leaves cores for the servers and
          // the agents' tmux sessions the workers start.
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: E2E_FILES,
          setupFiles: CLUSTER_SETUP,
          globalSetup: ['test/global-setup.ts'],
          // The server mutex keeps server-backed files one at a time, so a
          // second worker runs the files that need no server beside them
          // (E2eSequencer orders the files for that). A third would only
          // queue on the mutex.
          maxWorkers: 2,
          // A server-backed file's beforeAll waits on the mutex while the
          // other worker's server-backed file runs, up to the longest of
          // them, so a hook that spawns a server sets no timeout of its own.
          hookTimeout: 1_800_000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
