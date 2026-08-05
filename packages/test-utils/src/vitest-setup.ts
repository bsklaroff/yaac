import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/paths'

// Prevent parent git env vars from leaking into tests.
// Without this, running tests from within a git hook or subprocess would
// cause simpleGit in test helpers to operate on the real repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE

// Strip the host server's HTTP-posture config. When the suite runs inside a
// yaac session, the session preset carries YAAC_TRUST_PROXY=1 and
// YAAC_ALLOWED_HOSTS=<tailnet host> because the *outer* server sits behind
// `tailscale serve`. Every test server binds loopback directly, so no test
// needs either — but a test server reads them live and silently changes the
// posture under test: a spoofed X-Forwarded-Proto starts flipping session
// cookies to Secure, and an extra Host header becomes admissible. Stripped
// here rather than in unit-setup because e2e/api servers inherit
// `process.env` too, and the flags are wrong for them for the same reason.
// Tests that exercise the flags stub them per-case.
//
// YAAC_FORWARD_BIND rides along for the same reason: a remote-hosting host
// exports the tailnet IP so forwarded dev servers are reachable from other
// devices, and both suites assume the DEFAULT posture instead — the port
// unit tests assert the listener lands on loopback, and the e2e forwarding
// cases dial `127.0.0.1:<hostPort>`, which a tailnet-only listener refuses.
for (const key of [
  'YAAC_TRUST_PROXY', 'YAAC_ALLOWED_HOSTS', 'YAAC_REQUIRE_AUTH', 'YAAC_FORWARD_BIND',
] as const) {
  delete process.env[key]
}

// Note the third key: stripping the first two makes every test server a
// loopback-only deployment, which skips the bearer/cookie check by default —
// matching the real local posture, so most tests need no credential at all.
// The few tests that assert the credential gate opt in with
// `YAAC_REQUIRE_AUTH=1` (per file/case); the shared API-client helpers still
// send a bearer, which is simply ignored when the gate is off.

// Isolate the default data dir so tests that incidentally trigger
// serverLog() (or any other side effect rooted at getDataDir()) never
// write into the developer's real ~/.yaac. Tests that need their own
// data dir override this via setDataDir() in beforeEach.
setDataDir(path.join(os.tmpdir(), `yaac-test-default-${process.pid}`))
