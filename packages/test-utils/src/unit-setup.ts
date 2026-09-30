import { setHermeticScratch } from '#tmp'

// Setup for the `unit:*` projects only. Unit tests are hermetic, so an
// ambient YAAC_DATA_DIR from the developer's shell must not leak in; each
// test sets its own data dir.
delete process.env.YAAC_DATA_DIR

// A fresh data dir per test would cost ~4s per first getDb() (PGlite boot
// plus migrations). Share one in-memory instance per worker instead, wiped
// whenever the data dir changes. test/db/client.test.ts opts back out.
process.env.YAAC_TEST_SHARED_DB = '1'

// Unit runs create no pods, so scratch goes in the OS tmpdir (see
// testTmpBase()).
setHermeticScratch(true)
