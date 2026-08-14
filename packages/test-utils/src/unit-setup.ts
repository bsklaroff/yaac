import { setHermeticScratch } from '#tmp'

// Unit tests are hermetic: they never touch podman or the cluster and
// their assertions assume a clean host environment. An ambient
// YAAC_DATA_DIR — from the developer's own shell — would make getDataDir()
// resolve to that dir for any test that doesn't set its own, breaking
// otherwise deterministic assertions. Strip it so a unit run is identical
// wherever it runs; each test sets its own data dir via setDataDir /
// createTempDataDir. Only the `unit` project loads this file.
delete process.env.YAAC_DATA_DIR

// A unit test's data dir is a fresh temp dir per test, so its first getDb()
// pays ~2s to boot PGlite and ~2s to replay the migrations — far more than
// the assertions, and enough to make the DB-backed files the critical path of
// the whole unit run. Hand them all one in-memory instance instead, wiped
// whenever the data dir changes; the isolation a fresh dir buys is preserved,
// the boot is paid once per worker. The handle's own tests
// (test/db/client.test.ts) opt back out — the on-disk handle is what
// they're for. api/e2e never load this file.
process.env.YAAC_TEST_SHARED_DB = '1'

// Same hermeticity, applied to scratch: a unit run creates no pod, so its
// temp dirs need no node visibility and belong in the OS tmpdir (local,
// fast, OS-reaped) rather than under the data dir that api/e2e need. See
// testTmpBase().
setHermeticScratch(true)
