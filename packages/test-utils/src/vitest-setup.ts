import os from 'node:os'
import path from 'node:path'
import { setDataDir } from '@yaac/shared/paths'

// Keep a parent git hook's env from pointing test git at the real repo.
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE

// Strip vars an outer yaac workspace (or a remote-hosting host) exports,
// which would change what the servers under test accept:
// - YAAC_ALLOWED_HOSTS would admit extra Host headers, and
//   YAAC_ACCESS_MODE / YAAC_ACCESS_OWNER would change the access mode.
// - YAAC_FORWARD_BIND would move forward listeners off loopback.
// - YAAC_WORKSPACE_ID makes the identity rule treat any unproxied request
//   as local.
// - YAAC_SECRET / YAAC_SECRETS choose the key secrets are sealed under.
// - TS_OAUTH_CLIENT_ID / _SECRET would let `cluster install --tailnet`
//   install the Tailscale operator.
// Stripped for every project, since e2e/api servers inherit process.env.
// Tests that exercise these stub them per case.
for (const key of [
  'YAAC_ALLOWED_HOSTS', 'YAAC_ACCESS_MODE', 'YAAC_ACCESS_OWNER', 'YAAC_FORWARD_BIND',
  'YAAC_WORKSPACE_ID', 'YAAC_SECRET', 'YAAC_SECRETS', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_CLIENT_SECRET',
] as const) {
  delete process.env[key]
}

// Keep incidental writes (e.g. serverLog()) out of the real ~/.yaac. Tests
// that need their own data dir call setDataDir().
setDataDir(path.join(os.tmpdir(), `yaac-test-default-${process.pid}`))

// Forbid OAuth refresh grants for the whole suite. A refresh spends the
// stored refresh token. Inside a yaac workspace, the outer proxy swaps in
// the real token for any token-endpoint POST, so a test's refresh would
// rotate the outer install's credential and could leave it holding a spent
// one. The refresh-grant tests unstub this per case, behind a stubbed
// `fetch`.
process.env.YAAC_E2E_NO_TOKEN_REFRESH = '1'
