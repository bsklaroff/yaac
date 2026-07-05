#!/usr/bin/env node
// Stub for `claude auth login`, wired in via testEnv.toolLoginCliHook
// (YAAC_E2E_CLAUDE_LOGIN_CLI). Mimics the real CLI's browser login: prints
// the "opening browser" banner, then — as the localhost callback would —
// writes `.credentials.json` into $CLAUDE_CONFIG_DIR and exits 0.
// FAKE_LOGIN_MODE=fail exits 1 instead; FAKE_LOGIN_MODE=need-input mimics the
// manual paste-back path (credentials land only after a code arrives on
// stdin); FAKE_LOGIN_MODE=no-creds mimics the macOS CLI, which prints success
// and exits 0 but stores credentials only in the Keychain — never in
// $CLAUDE_CONFIG_DIR; FAKE_LOGIN_DELAY_MS stretches the window before
// credentials land (default 100ms).
const fs = require('node:fs')
const path = require('node:path')

const mode = process.env.FAKE_LOGIN_MODE || 'ok'
const delayMs = Number(process.env.FAKE_LOGIN_DELAY_MS || 100)

process.stdout.write('\x1b[1mOpening browser to sign in…\x1b[0m\n')
process.stdout.write('If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\n')

if (mode === 'fail') {
  process.stdout.write('OAuth error: access denied\n')
  process.exit(1)
}

function writeCreds() {
  const creds = {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-fake-web-login',
      refreshToken: 'sk-ant-ort01-fake-refresh',
      expiresAt: 9999999999999,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  }
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify(creds))
  setTimeout(() => process.exit(0), 200)
}

if (mode === 'no-creds') {
  setTimeout(() => {
    process.stdout.write('Login successful.\n')
    process.exit(0)
  }, delayMs)
} else if (mode === 'need-input') {
  process.stdout.write('Paste code here if prompted > ')
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    if (!buf.includes('\r') && !buf.includes('\n')) return
    if (buf.trim() === 'bad') {
      process.stdout.write('\nOAuth error: invalid authorization code\n')
      process.exit(1)
    }
    writeCreds()
  })
} else {
  setTimeout(writeCreds, delayMs)
}
