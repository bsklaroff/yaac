// Prevent parent git env vars from leaking into tests.
// Without this, running tests from a git hook (e.g. pre-push) would
// cause simpleGit in test helpers to operate on the real repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
