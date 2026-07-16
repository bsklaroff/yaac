import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/paths'

// Prevent parent git env vars from leaking into tests.
// Without this, running tests from within a git hook or subprocess would
// cause simpleGit in test helpers to operate on the real repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE

// Isolate the default data dir so tests that incidentally trigger
// serverLog() (or any other side effect rooted at getDataDir()) never
// write into the developer's real ~/.yaac. Tests that need their own
// data dir override this via setDataDir() in beforeEach.
setDataDir(path.join(os.tmpdir(), `yaac-test-default-${process.pid}`))
