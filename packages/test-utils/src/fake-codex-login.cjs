#!/usr/bin/env node
// Stub for `codex login`, wired in via testEnv.toolLoginCliHook
// (YAAC_E2E_CODEX_LOGIN_CLI). Mimics the real CLI's browser login: prints the
// localhost-callback banner, then — as the callback would — writes auth.json
// into $CODEX_HOME and exits 0. FAKE_LOGIN_MODE=fail exits 1 instead;
// FAKE_LOGIN_DELAY_MS stretches the login window (default 100ms).
const fs = require('node:fs')
const path = require('node:path')

const mode = process.env.FAKE_LOGIN_MODE || 'oauth'
const delayMs = Number(process.env.FAKE_LOGIN_DELAY_MS || 100)

console.log('Starting local login server on http://localhost:1455.')
console.log('If your browser did not open, navigate to this URL to authenticate:')
console.log('\x1b[94mhttps://auth.openai.com/oauth/authorize?response_type=code&state=x\x1b[0m')

if (mode === 'fail') {
  console.error('Login was not completed.')
  process.exit(1)
}

setTimeout(() => {
  const auth = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDB9.',
      access_token: 'codex-access-fake',
      refresh_token: 'codex-refresh-fake',
      account_id: 'acct_fake',
    },
    last_refresh: '2026-07-01T00:00:00.000Z',
  }
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify(auth))
  process.exit(0)
}, delayMs)
