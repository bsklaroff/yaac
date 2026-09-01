import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/paths'

// Prevent parent git env vars from leaking into tests.
// Without this, running tests from within a git hook or subprocess would
// cause simpleGit in test helpers to operate on the real repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE

// Strip the host server's HTTP-posture config. When the suite runs inside a
// yaac worktree, the worktree preset carries YAAC_TRUST_PROXY=1 and
// YAAC_ALLOWED_HOSTS=<tailnet host> because the *outer* server sits behind
// `tailscale serve`. Every test server binds loopback directly, so no test
// needs either — but a test server reads them live and silently changes the
// posture under test: a spoofed X-Forwarded-Proto starts flipping worktree
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
//
// YAAC_WORKTREE_ID is stripped for the same reason, and it is the subtlest of
// the set: inside a worktree the preset stamps it, and the credential gate
// reads it as "reachable only through the outer port-forward, so no token".
// Left in place, the cases that stub YAAC_ALLOWED_HOSTS to assert the gate
// comes back would see it skipped instead — passing on a developer host and
// failing inside a worktree. Nothing else reads it (the zsh prompt in
// Dockerfile.default is in-image), so no test loses anything.
//
// Note this one is stripped suite-WIDE, not just for unit runs the way
// YAAC_DATA_DIR is (unit-setup). It belongs with
// the posture vars instead because it IS one: e2e servers bind loopback
// and would reach the same answer either way, but the var's only reader is
// the credential gate, so leaving it to e2e would leave the posture under
// test depending on where the suite runs.
//
// YAAC_SERVER_GIT_NAME / YAAC_SERVER_GIT_EMAIL join the set because they are
// a rung of the identity chain a worktree commits under: exported in the
// ambient shell — the natural move for anyone debugging that very feature —
// they turn the absent-identity cases green-to-red, since `vi.unstubAllEnvs`
// restores an inherited value rather than clearing it. A test that wants the
// pair stubs it per-case.
for (const key of [
  'YAAC_TRUST_PROXY', 'YAAC_ALLOWED_HOSTS', 'YAAC_REQUIRE_AUTH', 'YAAC_FORWARD_BIND',
  'YAAC_WORKTREE_ID', 'YAAC_SERVER_GIT_NAME', 'YAAC_SERVER_GIT_EMAIL',
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

// Forbid OAuth refresh grants for the whole suite. Unlike the data-dir
// isolation above, this protects something OUTSIDE the machine: a refresh
// grant spends the stored refresh token and issues a new one, so it is the
// only upstream call a test can make that damages state a temp dir cannot
// contain.
//
// It matters most exactly where this suite most often runs — inside a yaac
// worktree. That worktree's egress is mediated, and the proxy rewrites the
// `refresh_token` body param of anything POSTed to a token endpoint to the
// real stored token WITHOUT checking what the request carried. So a test
// presenting a sentinel, or a fabricated string, or a bundle seeded three
// fixtures ago still rotates the credential of the install hosting the
// worktree — and, because the response capture IS gated on the sentinel,
// that install may never learn the new token and is left holding a spent
// one. Every worktree sharing it is then signed out.
//
// Seeded expiries are not a defense: they decide whether a refresh is
// ATTEMPTED, and the attempt is already the damage. The refresh-grant tests
// unstub this per-case, behind a stubbed `fetch`.
process.env.YAAC_E2E_NO_TOKEN_REFRESH = '1'
