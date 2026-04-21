import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { authUpdate } from '@/commands/auth-update'
import type * as toolAuthInteractive from '@/shared/tool-auth-interactive'
import { loadClaudeCredentialsFile } from '@/lib/project/tool-auth'
import type { ClaudeOAuthBundle } from '@/shared/types'
import type { ToolLoginResult } from '@/shared/tool-auth-interactive'

const { mockQuestion, mockClose, mockRunToolLogin } = vi.hoisted(() => ({
  mockQuestion: vi.fn<(prompt: string) => Promise<string>>(),
  mockClose: vi.fn(),
  mockRunToolLogin: vi.fn<(tool: unknown) => Promise<ToolLoginResult>>(),
}))

vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: vi.fn().mockReturnValue({
      question: mockQuestion,
      close: mockClose,
    }),
  },
}))

vi.mock('@/shared/tool-auth-interactive', async () => {
  const actual = await vi.importActual<typeof toolAuthInteractive>('@/shared/tool-auth-interactive')
  return {
    ...actual,
    runToolLogin: mockRunToolLogin,
  }
})

/**
 * The menu-cancel and GitHub-token paths are covered by
 * `test/e2e-cli/auth-update.test.ts` via piped stdin. What's unique
 * here is the Claude OAuth save path: runToolLogin() shells out to
 * `claude login` in production, which a spawned CLI can't drive
 * without a real Claude-side OAuth server. Mocking the login lets us
 * exercise the CLI → daemon wiring for OAuth-bundle persistence.
 */
describe('yaac auth update — tool OAuth save', () => {
  let tmpDir: string
  let daemon: InProcessDaemon

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    daemon = await bootInProcessDaemon()
    mockQuestion.mockReset()
    mockClose.mockReset()
    mockRunToolLogin.mockReset()
  })

  afterEach(async () => {
    await daemon.stop()
    await cleanupTempDir(tmpDir)
  })

  it('saves a Claude OAuth bundle via PUT /auth/claude', async () => {
    const bundle: ClaudeOAuthBundle = {
      accessToken: 'sk-oat-fake-access',
      refreshToken: 'sk-oat-fake-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    }

    mockQuestion.mockResolvedValueOnce('2')
    mockRunToolLogin.mockResolvedValueOnce({
      kind: 'oauth',
      apiKey: bundle.accessToken,
      claudeBundle: bundle,
    })

    await authUpdate()

    expect(mockRunToolLogin).toHaveBeenCalledWith('claude')
    const saved = await loadClaudeCredentialsFile()
    expect(saved?.kind).toBe('oauth')
    if (saved?.kind === 'oauth') {
      expect(saved.claudeAiOauth).toEqual(bundle)
    }
  })
})
