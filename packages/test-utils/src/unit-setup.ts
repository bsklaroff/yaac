import { setHermeticScratch } from '#tmp'

// Unit tests are hermetic: they never touch podman or the cluster and
// their assertions assume a clean host environment. When the suite runs
// *inside* a yaac session (nested yaac), the session preset leaks
// YAAC_NESTED=1, YAAC_DATA_DIR, and YAAC_K8S_REGISTRY into the process.
// Those flip environment-sensitive code paths — registryHost() returns the
// outer install's per-project registry instead of this install's own
// in-cluster registry Service, createSession /
// runClusterCheck take their nested branches, and getDataDir() resolves to
// the session's node-shared virtiofs data dir (slow, coarse file
// timestamps) for any test that doesn't set its own — which breaks
// otherwise deterministic unit assertions. Strip them so a unit run is
// identical on a developer host and inside a session; each test sets its
// own data dir via setDataDir / createTempDataDir.
//
// Only the `unit` project loads this file. E2e tests run the real CLI
// in-container and genuinely need the nested-session env (the server
// subprocess inherits it), so the shared test/setup.ts leaves it intact.
// Tests that exercise nested behavior set YAAC_NESTED themselves and clean
// up afterwards, so clearing the ambient default here is safe.
for (const key of ['YAAC_NESTED', 'YAAC_DATA_DIR', 'YAAC_K8S_REGISTRY'] as const) {
  delete process.env[key]
}

// A unit test's data dir is a fresh temp dir per test, so its first getDb()
// pays ~2s to boot PGlite and ~2s to replay the migrations — far more than
// the assertions, and enough to make the DB-backed files the critical path of
// the whole unit run. Hand them all one in-memory instance instead, wiped
// whenever the data dir changes; the isolation a fresh dir buys is preserved,
// the boot is paid once per worker. platform/db's own tests opt back out —
// the on-disk handle is what they're for. api/e2e never load this file.
process.env.YAAC_TEST_SHARED_DB = '1'

// Same hermeticity, applied to scratch: a unit run creates no pod, so its
// temp dirs need no node visibility and belong in the OS tmpdir (local,
// fast, OS-reaped) rather than under the data dir that api/e2e need. See
// testTmpBase().
setHermeticScratch(true)
