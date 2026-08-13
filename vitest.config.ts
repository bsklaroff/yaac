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
// File paths, not @yaac/test-utils specifiers: vitest resolves setupFiles
// with plain Node semantics, which can't substitute .ts sources for the
// output-form (.js) targets in the package's exports map.
const SETUP = ['./packages/test-utils/src/vitest-setup.ts']
const UNIT_SETUP = [...SETUP, './packages/test-utils/src/unit-setup.ts']
// Stubs @kubernetes/client-node, which costs ~2.8s to evaluate in every
// isolated test file that reaches #drivers/k8s/substrate — the largest
// single cost in a unit run. Withheld from the projects whose subject is a k8s client
// (k8s/proxy, k8s/netd build real KubeConfigs and informers); api/e2e talk to
// a real cluster and never load it either.
const K8S_STUB_SETUP = './packages/test-utils/src/k8s-stub-setup.ts'
// api/e2e only: drops each file's test namespace as it finishes, so a run
// doesn't accumulate one netd DaemonSet per completed file on the single
// node the remaining files still have to share.
const CLUSTER_SETUP = [...SETUP, './packages/test-utils/src/cluster-setup.ts']

/** Machine-readable record of the last run — see the `reporters` note below.
 *  `scripts/test-failures.ts` renders the failures out of it. */
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
    // Coverage is measurement-only for now: no thresholds, so nothing fails
    // on it. It exists to answer "is this module still exercised?" once a
    // folder is sealed behind a barrel and its internals lose direct unit
    // tests — the internals stay covered transitively through the barrel,
    // and this is what proves it. Thresholds get pinned from a measured
    // baseline rather than guessed.
    coverage: {
      provider: 'v8',
      include: ['packages/server/src/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
    },
    testTimeout: 120_000,
    // E2e beforeAll/beforeEach hooks start containers on cold caches AND
    // wait their turn on the cross-worker server mutex — with many
    // workers queued, a waiter can sit well past vitest's 10s default.
    // Raised to 600s so queued hooks don't false-fail as flakes.
    hookTimeout: 600_000,
    // Every run also writes its failures to a file, so "what broke?" is a
    // read, never a re-run. A full-suite run prints thousands of lines and
    // takes minutes; whoever (or whatever) truncated the console output —
    // a `| tail`, a scrollback limit, a killed terminal — can recover the
    // failing test names, messages and stacks from here instead of paying
    // for the suite twice. Overwritten per run, gitignored.
    reporters: ['default', ['json', { outputFile: TEST_FAILURES_FILE }]],
    projects: [
      // Co-located per-package unit tests. Names are `unit:<pkg>`.
      unitProject('packages/cli'),
      // .tsx component tests: transform JSX via esbuild (no react plugin
      // needed for tests); jsdom is selected per-file via
      // `// @vitest-environment jsdom`.
      unitProject('packages/frontend', {
        esbuild: { jsx: 'automatic' },
      }),
      unitProject('packages/desktop'),
      unitProject('packages/server'),
      unitProject('packages/shared'),
      unitProject('packages/auth-daemon'),
      unitProject('packages/test-utils'),
      // Self-imports (yaac-proxy-sidecar/<mod>, yaac-netd/<mod>) resolve
      // via each package's own exports map — no alias needed.
      unitProject('k8s/proxy'),
      unitProject('k8s/netd'),
      // streamd (the in-pod stream daemon) is plain JS baked into the base
      // image; its tests exercise the daemon in-process. Deliberately not
      // in the root tsconfig (untyped .js imports), so vitest is its only
      // gate.
      unitProject('dockerfiles/streamd'),
      // acpd (the in-pod ACP agent supervisor) — same deal as streamd:
      // plain JS in the base image, outside the root tsconfig, gated here.
      unitProject('dockerfiles/acpd'),
      // api + e2e live in the root test/ tree (inherently cross-package).
      {
        extends: true,
        test: {
          name: 'api',
          include: ['test/api/**/*.test.ts'],
          setupFiles: CLUSTER_SETUP,
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
          setupFiles: CLUSTER_SETUP,
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
