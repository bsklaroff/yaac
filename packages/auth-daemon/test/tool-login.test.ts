import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as cliResolveModule from '#cli-resolve'
import {
  killAllToolLogins,
  cancelToolLogin,
  getToolLogin,
  sendToolLoginInput,
  setToolLoginPersistence,
  startToolLogin,
} from '#tool-login'
import type { ToolLoginResult } from '@yaac/shared/tool-auth-interactive'
import { CLAUDE_STUB, CODEX_STUB } from '@yaac/test-utils/fixtures'

// Consulted only when the YAAC_E2E_*_LOGIN_CLI hook is unset. Mocked to "not
// installed" so no test can spawn a real vendor CLI.
vi.mock('#cli-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof cliResolveModule>()
  return { ...actual, resolveToolCliPath: () => null }
})

async function waitForStatus(id: string, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getToolLogin(id).status).toBe(status)
  }, { timeout: 10_000, interval: 25 })
}

/** What each login handed the server, by tool. */
const persisted = new Map<string, ToolLoginResult>()
setToolLoginPersistence((tool, result) => { persisted.set(tool, result); return Promise.resolve() })

describe('tool login sessions', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    persisted.clear()
    process.env.YAAC_E2E_CLAUDE_LOGIN_CLI = JSON.stringify([process.execPath, CLAUDE_STUB])
    process.env.YAAC_E2E_CODEX_LOGIN_CLI = JSON.stringify([process.execPath, CODEX_STUB])
  })

  afterEach(async () => {
    killAllToolLogins()
    delete process.env.YAAC_E2E_CLAUDE_LOGIN_CLI
    delete process.env.YAAC_E2E_CODEX_LOGIN_CLI
    delete process.env.FAKE_LOGIN_MODE
    delete process.env.FAKE_LOGIN_DELAY_MS
    await cleanupTempDir(tmpDir)
  })

  it('claude: browser login lands, full OAuth bundle is persisted', async () => {
    const started = await startToolLogin('claude')
    expect(started.status).toBe('running')

    await waitForStatus(started.id, 'success')
    const saved = persisted.get('claude')
    expect(saved?.kind).toBe('oauth')
    if (saved?.kind !== 'oauth') return
    expect(saved.claudeBundle?.accessToken).toBe('sk-ant-oat01-fake-web-login')
    // The browser login yields a real refreshable bundle, unlike a pasted key.
    expect(saved.claudeBundle?.refreshToken).toBe('sk-ant-ort01-fake-refresh')
    expect(saved.claudeBundle?.subscriptionType).toBe('max')
  })

  it('claude: the polled view carries the CLI output with the printed URL', async () => {
    process.env.FAKE_LOGIN_DELAY_MS = '3000' // hold at running long enough to poll output
    const started = await startToolLogin('claude')

    await vi.waitFor(() => {
      expect(getToolLogin(started.id).output).toContain('https://claude.com/cai/oauth/authorize')
    }, { timeout: 10_000, interval: 25 })
    expect(getToolLogin(started.id).status).toBe('running')
  })

  it('claude: manual paste-back — stdin input completes the login', async () => {
    process.env.FAKE_LOGIN_MODE = 'need-input'
    const started = await startToolLogin('claude')

    // The CLI's paste prompt is filtered from the output, so wait for the URL.
    await vi.waitFor(() => {
      expect(getToolLogin(started.id).output).toContain('oauth/authorize')
    }, { timeout: 10_000, interval: 25 })

    sendToolLoginInput(started.id, ' code-from-page ')
    await waitForStatus(started.id, 'success')
    expect(persisted.get('claude')?.kind).toBe('oauth')
    // The prompt the stub printed never reaches the presented output.
    expect(getToolLogin(started.id).output).not.toContain('Paste code here')
  })

  it('whitelists stdin to the code alphabet — shell metachars and escapes never pass', async () => {
    process.env.FAKE_LOGIN_MODE = 'need-input'
    const started = await startToolLogin('claude')
    await vi.waitFor(() => {
      expect(getToolLogin(started.id).output).toContain('oauth/authorize')
    }, { timeout: 10_000, interval: 25 })

    const hostile = [
      'rm -rf /',            // spaces + shell command
      '$(reboot)',           // command substitution
      '`id`',                // backticks
      'a;b && c',            // separators
      'x\x1b[2Jy',           // ANSI escape
      'a\rb',                // embedded carriage return (extra "line")
      'x\x03',               // Ctrl-C
      '"quoted"',            // quotes
      'x'.repeat(600),       // overlong
      '',                    // empty
    ]
    for (const text of hostile) {
      expect(() => sendToolLoginInput(started.id, text)).toThrow(/authorize page/)
    }

    // The flow survives rejected pastes and still completes with a real code.
    expect(getToolLogin(started.id).status).toBe('running')
    sendToolLoginInput(started.id, 'code-123#state_ABC')
    await waitForStatus(started.id, 'success')
    expect(persisted.get('claude')?.kind).toBe('oauth')
  })

  it('rejects input on codex flows (no stdin) and unknown sessions', async () => {
    process.env.FAKE_LOGIN_DELAY_MS = '3000'
    const started = await startToolLogin('codex')
    expect(() => sendToolLoginInput(started.id, 'x')).toThrow(/not accepting input/)
    expect(() => sendToolLoginInput('nope', 'x')).toThrow(/No sign-in session/)
  })

  it('a missing CLI fails immediately with cliMissing for the install button', async () => {
    delete process.env.YAAC_E2E_CLAUDE_LOGIN_CLI
    delete process.env.YAAC_E2E_CODEX_LOGIN_CLI

    const claude = await startToolLogin('claude')
    expect(claude.status).toBe('error')
    expect(claude.cliMissing).toBe(true)
    expect(claude.error).toContain('Claude Code is not installed')

    const codex = await startToolLogin('codex')
    expect(codex.status).toBe('error')
    expect(codex.cliMissing).toBe(true)
    expect(codex.error).toContain('Codex is not installed')
  })

  it('claude: a failed login surfaces the CLI output as the error', async () => {
    process.env.FAKE_LOGIN_MODE = 'fail'
    const started = await startToolLogin('claude')

    await waitForStatus(started.id, 'error')
    expect(getToolLogin(started.id).error).toContain('access denied')
    expect(persisted.get('claude')).toBeUndefined()
  })

  it('codex: browser login lands, auth.json is persisted as a bundle', async () => {
    const started = await startToolLogin('codex')
    expect(started.status).toBe('running')

    await waitForStatus(started.id, 'success')
    const saved = persisted.get('codex')
    expect(saved?.kind).toBe('oauth')
    if (saved?.kind !== 'oauth') return
    expect(saved.codexBundle?.accessToken).toBe('codex-access-fake')
    expect(saved.codexBundle?.accountId).toBe('acct_fake')
  })

  it('codex: a failed login surfaces the CLI output as the error', async () => {
    process.env.FAKE_LOGIN_MODE = 'fail'
    const started = await startToolLogin('codex')

    await waitForStatus(started.id, 'error')
    expect(getToolLogin(started.id).error).toContain('Login was not completed')
    expect(persisted.get('codex')).toBeUndefined()
  })

  it('unknown ids 404; cancel forgets the session and is idempotent', async () => {
    expect(() => getToolLogin('nope')).toThrow(/No sign-in session/)

    const started = await startToolLogin('codex')
    cancelToolLogin(started.id)
    expect(() => getToolLogin(started.id)).toThrow(/No sign-in session/)
    cancelToolLogin(started.id) // already gone — a no-op
  })

  it('restarting a tool sign-in cancels the previous flow', async () => {
    process.env.FAKE_LOGIN_DELAY_MS = '5000' // keep the first flow alive until the second starts
    const first = await startToolLogin('codex')
    process.env.FAKE_LOGIN_DELAY_MS = '50'
    const second = await startToolLogin('codex')
    expect(() => getToolLogin(first.id)).toThrow(/No sign-in session/)
    await waitForStatus(second.id, 'success')
  })
})
