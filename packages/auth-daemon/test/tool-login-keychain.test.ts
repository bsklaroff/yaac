import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as toolAuthInteractiveModule from '@yaac/shared/tool-auth-interactive'

// On macOS the real CLI writes no scratch `.credentials.json`; the login
// lands only in the Keychain, under a service name suffixed with a hash of
// CLAUDE_CONFIG_DIR. The Keychain reads are mocked so these tests run on any
// OS.
const keychain = vi.hoisted(() => ({
  read: vi.fn<(service?: string) => string | null>(() => null),
  del: vi.fn<(service: string) => void>(),
}))

vi.mock('@yaac/shared/tool-auth-interactive', async (importOriginal) => {
  const actual = await importOriginal<typeof toolAuthInteractiveModule>()
  return {
    ...actual,
    readClaudeKeychainPayload: keychain.read,
    deleteScopedClaudeKeychainItem: keychain.del,
  }
})

import {
  clearAllToolLoginsForTests,
  getToolLogin,
  startToolLogin,
} from '#tool-login'
import { loadClaudeCredentialsFile } from '@yaac/shared/tool-auth'
import { CLAUDE_STUB } from '@yaac/test-utils/fixtures'

const KEYCHAIN_BUNDLE = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-from-keychain',
    refreshToken: 'sk-ant-ort01-from-keychain',
    expiresAt: 9999999999999,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
})

async function waitForStatus(id: string, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getToolLogin(id).status).toBe(status)
  }, { timeout: 10_000, interval: 25 })
}

describe('claude web login detected via the macOS keychain', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    process.env.YAAC_E2E_CLAUDE_LOGIN_CLI = JSON.stringify([process.execPath, CLAUDE_STUB])
    process.env.FAKE_LOGIN_MODE = 'no-creds' // macOS CLI: nothing lands in $CLAUDE_CONFIG_DIR
    keychain.read.mockReset()
    keychain.del.mockReset()
    keychain.read.mockReturnValue(null)
  })

  afterEach(async () => {
    clearAllToolLoginsForTests()
    delete process.env.YAAC_E2E_CLAUDE_LOGIN_CLI
    delete process.env.FAKE_LOGIN_MODE
    await cleanupTempDir(tmpDir)
  })

  it('a config-dir-scoped keychain item completes the login and is swept', async () => {
    // Only the scratch login's hash-suffixed item is read, never the user's.
    keychain.read.mockImplementation((service) => (service ? KEYCHAIN_BUNDLE : null))

    const started = await startToolLogin('claude')
    await waitForStatus(started.id, 'success')

    const saved = await loadClaudeCredentialsFile()
    expect(saved?.kind).toBe('oauth')
    if (saved?.kind !== 'oauth') return
    expect(saved.claudeAiOauth.accessToken).toBe('sk-ant-oat01-from-keychain')

    // Reads and the post-login cleanup both target the scoped item.
    const services = keychain.read.mock.calls.map((c) => c[0])
    expect(services.length).toBeGreaterThan(0)
    for (const service of services) {
      expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    }
    expect(keychain.del).toHaveBeenCalledWith(services[0])
  })

  it('no credentials anywhere — the flow errors with the CLI output tail', async () => {
    const started = await startToolLogin('claude')
    await waitForStatus(started.id, 'error')
    expect(getToolLogin(started.id).error).toContain('Login successful.')
    expect(await loadClaudeCredentialsFile()).toBeNull()
    // The scratch keychain sweep still runs on failure.
    expect(keychain.del).toHaveBeenCalled()
  })
})
