import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { bootInProcessDaemon, type InProcessDaemon } from '@test/helpers/daemon'
import { authUpdate } from '@/commands/auth-update'
import { loadCredentials } from '@/lib/project/credentials'
import type * as toolAuth from '@/lib/project/tool-auth'
import { loadClaudeCredentialsFile, type ToolLoginResult } from '@/lib/project/tool-auth'
import type { ClaudeOAuthBundle } from '@/types'

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

vi.mock('@/lib/project/tool-auth', async () => {
  const actual = await vi.importActual<typeof toolAuth>('@/lib/project/tool-auth')
  return {
    ...actual,
    runToolLogin: mockRunToolLogin,
  }
})

describe('yaac auth update — happy path', () => {
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

  it('saves a GitHub token via POST /auth/github/tokens', async () => {
    mockQuestion
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('acme/*')
      .mockResolvedValueOnce('ghp_a_fake_token')

    await authUpdate()

    const creds = await loadCredentials()
    expect(creds.tokens).toEqual([{ pattern: 'acme/*', token: 'ghp_a_fake_token' }])
  })

  it('prints "Cancelled." on an invalid menu choice and does not persist', async () => {
    mockQuestion.mockResolvedValueOnce('x')
    const logs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => logs.push(msg)

    await authUpdate()

    console.log = origLog
    expect(logs).toContain('Cancelled.')
    expect(mockRunToolLogin).not.toHaveBeenCalled()
  })
})
