import { configDefaults, defineConfig } from 'vitest/config'
// A file path, like the setupFiles below.
import { kindByoLayout } from './packages/test-utils/src/kind-byo-layout.js'

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
// which build real KubeConfigs and informers, or for api/e2e.
const K8S_STUB_SETUP = './packages/test-utils/src/k8s-stub-setup.ts'
// api/e2e only: deletes each file's test namespace when the file finishes,
// so finished files' netd DaemonSets don't pile up on the single node.
const CLUSTER_SETUP = [...SETUP, './packages/test-utils/src/cluster-setup.ts']
// api-containerless only: registers the real containerless driver in place
// of the composition root.
const CONTAINERLESS_SETUP = [...SETUP, './packages/test-utils/src/containerless-setup.ts']
/**
 * The api files that need no cluster: the containerless column of the route
 * matrix, plus files that drive the Hono app in process over routes no
 * driver feature gates. The rest need the k8s driver (`routes-k8s`) or hit
 * routes that answer `NOT_SUPPORTED` without it (`write-routes`, the image
 * routes).
 */
const CONTAINERLESS_API = [
  'test/api/routes-containerless.test.ts',
  'test/api/auth.test.ts',
  'test/api/read-marks.test.ts',
  'test/api/server.test.ts',
  'test/api/shortcuts.test.ts',
  'test/api/identity-flow.test.ts',
  // Driver-neutral: guards WebSocket compression pass-through, which a
  // dependency bump could break for every install, so it also runs where
  // there is no cluster.
  'test/api/websocket-compression.test.ts',
]

/** The k8s e2e files, run against the kind rig (`e2e`) and kind-byo (`e2e-byo`). */
const E2E_FILES = ['test/e2e/**/*.test.ts', 'test/e2e-cli/**/*.test.ts']
/**
 * The installed kind-byo server itself. A project of its own: its last case
 * deletes the install namespace, registry included, which would take every
 * other file's prebuilt images with it.
 */
const BYO_INSTALL = ['test/e2e-cli/byo-install-suite.test.ts']
/** The env that points a project at kind-byo; see the e2e-byo project. */
const BYO_ENV = {
  YAAC_TEST_BACKEND: 'byo',
  KUBECONFIG: kindByoLayout().kubeconfig,
  YAAC_DATA_DIR: kindByoLayout().dataDir,
  // kind-byo's tailnet origin carries a Let's Encrypt staging certificate;
  // every CLI a file spawns trusts its roots (a worker, started before this
  // env lands, trusts them in-process — see byo-install-suite).
  NODE_EXTRA_CA_CERTS: kindByoLayout().stagingCa,
}

/** JSON record of the last run; `pnpm test:failures`
 *  (scripts/test-failures.ts) prints the failures from it. */
const TEST_FAILURES_FILE = './.vitest-last-run.json'

function unitProject(pkgDir: string, extra: object = {}) {
  const realK8sClient = pkgDir.startsWith('k8s/')
  return {
    extends: true as const,
    ...extra,
    test: {
      name: `unit:${pkgDir.split('/').pop()!}`,
      include: [`${pkgDir}/test/**/*.test.{ts,tsx}`],
      setupFiles: realK8sClient ? UNIT_SETUP : [...UNIT_SETUP, K8S_STUB_SETUP],
      sequence: { groupOrder: 0 },
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
    // Also write results to a file so failures can be recovered after the
    // console output is truncated, without re-running. Overwritten per run,
    // gitignored.
    reporters: ['default', ['json', { outputFile: TEST_FAILURES_FILE }]],
    projects: [
      // Co-located per-package unit tests. Names are `unit:<pkg>`.
      unitProject('packages/cli'),
      // esbuild transforms JSX, so no react plugin is needed; jsdom is
      // selected per file via `// @vitest-environment jsdom`.
      unitProject('packages/frontend', {
        esbuild: { jsx: 'automatic' },
      }),
      unitProject('packages/desktop'),
      unitProject('packages/server'),
      unitProject('packages/shared'),
      unitProject('packages/auth-daemon'),
      unitProject('packages/test-utils'),
      unitProject('k8s/proxy'),
      unitProject('k8s/netd'),
      // streamd (in-pod stream daemon), acpd (in-pod ACP supervisor) and
      // the agent patches are plain JS shipped in dockerfiles/ and outside
      // the root tsconfig, so these tests are their only check.
      unitProject('dockerfiles/streamd'),
      unitProject('dockerfiles/acpd'),
      unitProject('dockerfiles/agent-patches'),
      // api + e2e live in the root test/ tree. The api tier has one project
      // per driver, matching the route matrix's two columns, so the
      // containerless half can run where there is no cluster.
      {
        extends: true,
        test: {
          name: 'api-k8s',
          include: ['test/api/**/*.test.ts'],
          // `exclude` replaces the defaults, so spread them back in.
          exclude: [...configDefaults.exclude, ...CONTAINERLESS_API],
          setupFiles: CLUSTER_SETUP,
          // Image pre-builds are set per project, not at the root: with
          // `extends: true` a root globalSetup would also run for every unit
          // project, and unit tests must never touch podman.
          globalSetup: ['test/global-setup.ts'],
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
      // workspaces as tmux sessions on this host. No cluster or images, so
      // the global setup only builds the CLI.
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
          // Each file holds the cross-worker server mutex
          // (packages/test-utils/src/cli.ts) for its whole run, so more
          // workers add no parallelism and only move the mutex wait into a
          // beforeAll, where it counts against the hook timeout.
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: E2E_FILES,
          exclude: [...configDefaults.exclude, ...BYO_INSTALL],
          setupFiles: CLUSTER_SETUP,
          globalSetup: ['test/global-setup.ts'],
          // The server mutex already serializes server-backed work, so more
          // workers only queue on the shared podman socket and cause
          // load-induced timeouts.
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      // The same files against kind-byo, a local stand-in for a cloud
      // cluster (docs/server-in-cluster.md, "The e2e tiers run against
      // this"). Its data dir is the ambient one, so all test scratch sits
      // inside the NFS export. Run `pnpm kind-byo up` first; the global
      // setup refuses without it.
      {
        extends: true,
        test: {
          name: 'e2e-byo',
          include: E2E_FILES,
          exclude: [...configDefaults.exclude, ...BYO_INSTALL],
          setupFiles: CLUSTER_SETUP,
          globalSetup: ['test/global-setup.ts'],
          env: BYO_ENV,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e-byo-install',
          include: BYO_INSTALL,
          setupFiles: CLUSTER_SETUP,
          globalSetup: ['test/global-setup.ts'],
          env: BYO_ENV,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
})
