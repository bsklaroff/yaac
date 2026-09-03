import { describe, it, expect, vi, beforeEach } from 'vitest'
import readline from 'node:readline/promises'
import { ensureGitIdentity } from '#commands/git-identity'
import { seedGitIdentityFromShell } from '@yaac/shared/git-identity-seed'
import { getApiClient } from '@yaac/shared/server-api'

vi.mock('node:readline/promises', () => ({
  default: { createInterface: vi.fn() },
}))

// The seed is the whole first half of this command: ask the server, and give
// it this machine's git config if it has none. Mocked so the cases below are
// about what happens on each answer, not about the round trip.
vi.mock('@yaac/shared/git-identity-seed', () => ({
  seedGitIdentityFromShell: vi.fn(),
}))

const mockPut = vi.fn()
vi.mock('@yaac/shared/server-api', () => ({
  getApiClient: vi.fn(() => ({ config: { 'git-identity': { $put: mockPut } } })),
}))

function mockPrompt(answers: string[]): { close: ReturnType<typeof vi.fn> } {
  const question = vi.fn()
  for (const answer of answers) question.mockResolvedValueOnce(answer)
  const close = vi.fn()
  vi.mocked(readline.createInterface).mockReturnValue({ question, close } as never)
  return { close }
}

describe('ensureGitIdentity', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    vi.clearAllMocks()
    mockPut.mockResolvedValue({ identity: { name: 'Grace', email: 'grace@example.com' } })
  })

  it('takes what the server has, or what this machine just gave it', async () => {
    vi.mocked(seedGitIdentityFromShell).mockResolvedValue({ name: 'Ada', email: 'ada@example.com' })

    const identity = await ensureGitIdentity()

    expect(identity).toEqual({ name: 'Ada', email: 'ada@example.com' })
    expect(logSpy).toHaveBeenCalledWith('Git identity: Ada <ada@example.com>')
    expect(readline.createInterface).not.toHaveBeenCalled()
  })

  it('prompts when neither has one, and saves the answer to the SERVER', async () => {
    // Not to this machine's global git config: against a remote server that
    // would configure the wrong machine, and the identity a worktree commits
    // under is the server's setting either way.
    vi.mocked(seedGitIdentityFromShell).mockResolvedValue(null)
    const { close } = mockPrompt(['Grace', 'grace@example.com'])

    const identity = await ensureGitIdentity()

    expect(identity).toEqual({ name: 'Grace', email: 'grace@example.com' })
    expect(getApiClient).toHaveBeenCalled()
    expect(mockPut).toHaveBeenCalledWith({ json: { name: 'Grace', email: 'grace@example.com' } })
    expect(close).toHaveBeenCalled()
  })

  it('returns undefined without saving when a prompt answer is empty', async () => {
    vi.mocked(seedGitIdentityFromShell).mockResolvedValue(null)
    mockPrompt(['Grace', ''])

    const identity = await ensureGitIdentity()

    expect(identity).toBeUndefined()
    expect(mockPut).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('Git user.name and user.email are required.')
  })
})
