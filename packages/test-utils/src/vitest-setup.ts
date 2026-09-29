import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/paths'

// Prevent parent git env vars from leaking into tests.
// Without this, running tests from within a git hook or subprocess would
// cause git in test helpers to operate on the real repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE

// Strip the host server's HTTP-posture config. When the suite runs inside a
// yaac worktree, the worktree preset carries YAAC_ALLOWED_HOSTS=<tailnet
// host> because the *outer* server sits behind `tailscale serve`. Every test
// server binds loopback directly, so no test needs it — but a test server
// reads it live, and an extra Host header becomes admissible. Stripped here
// rather than in unit-setup because e2e/api servers inherit `process.env`
// too, and the var is wrong for them for the same reason. Tests that
// exercise it stub it per-case.
//
// YAAC_FORWARD_BIND rides along for the same reason: a remote-hosting host
// exports the tailnet IP so forwarded dev servers are reachable from other
// devices, and both suites assume the DEFAULT posture instead — the port
// unit tests assert the listener lands on loopback, and the e2e forwarding
// cases dial `127.0.0.1:<hostPort>`, which a tailnet-only listener refuses.
//
// YAAC_WORKTREE_ID is stripped for the same reason, and it is the subtlest of
// the set: inside a worktree the preset stamps it, and the identity rule
// reads it as "reached through the outer install's forward, so an unproxied
// request is local whatever Host it names". Left in place, the cases that
// assert a non-loopback name is refused would see it admitted instead —
// passing on a developer host and failing inside a worktree. Stripped
// suite-WIDE, not just for unit runs the way YAAC_DATA_DIR is (unit-setup),
// because e2e servers read it on the same path, so leaving it would leave
// the posture under test depending on where the suite runs.
//
// YAAC_SECRET / YAAC_SECRETS join the set because they decide which key
// stored secrets are sealed under, so an exported one would change what a
// store test finds in the column while every assertion about the value
// still passed.
for (const key of [
  'YAAC_ALLOWED_HOSTS', 'YAAC_FORWARD_BIND', 'YAAC_WORKTREE_ID', 'YAAC_SECRET', 'YAAC_SECRETS',
] as const) {
  delete process.env[key]
}

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
