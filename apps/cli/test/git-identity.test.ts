import { describe, it, expect, vi, beforeEach } from 'vitest'
import readline from 'node:readline/promises'
import simpleGit from 'simple-git'
import { ensureGitIdentity } from '#commands/git-identity'
import { getGitUserConfig } from '@yaac/shared/git'
import type * as sharedGitModule from '@yaac/shared/git'

vi.mock('node:readline/promises', () => ({
  default: { createInterface: vi.fn() },
}))

vi.mock('simple-git', () => ({
  default: vi.fn(),
}))

vi.mock('@yaac/shared/git', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGitModule>()
  return {
    ...actual,
    getGitUserConfig: vi.fn(),
  }
})

function mockPrompt(answers: string[]): { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const question = vi.fn()
  for (const answer of answers) question.mockResolvedValueOnce(answer)
  const close = vi.fn()
  vi.mocked(readline.createInterface).mockReturnValue({ question, close } as never)
  return { question, close }
}

describe('ensureGitIdentity', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the configured identity without prompting', async () => {
    vi.mocked(getGitUserConfig).mockResolvedValue({ name: 'Ada', email: 'ada@example.com' })

    const identity = await ensureGitIdentity()

    expect(identity).toEqual({ name: 'Ada', email: 'ada@example.com' })
    expect(logSpy).toHaveBeenCalledWith('Git identity: Ada <ada@example.com>')
    expect(readline.createInterface).not.toHaveBeenCalled()
  })

  it('prompts for and persists the identity when the global config is missing', async () => {
    vi.mocked(getGitUserConfig).mockResolvedValue(null)
    const { close } = mockPrompt(['Grace', 'grace@example.com'])
    const addConfig = vi.fn().mockResolvedValue(undefined)
    vi.mocked(simpleGit).mockReturnValue({ addConfig } as never)

    const identity = await ensureGitIdentity()

    expect(identity).toEqual({ name: 'Grace', email: 'grace@example.com' })
    expect(addConfig).toHaveBeenCalledWith('user.name', 'Grace', false, 'global')
    expect(addConfig).toHaveBeenCalledWith('user.email', 'grace@example.com', false, 'global')
    expect(close).toHaveBeenCalled()
  })

  it('returns undefined without writing config when a prompt answer is empty', async () => {
    vi.mocked(getGitUserConfig).mockResolvedValue(null)
    mockPrompt(['Grace', ''])
    const addConfig = vi.fn()
    vi.mocked(simpleGit).mockReturnValue({ addConfig } as never)

    const identity = await ensureGitIdentity()

    expect(identity).toBeUndefined()
    expect(addConfig).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('Git user.name and user.email are required.')
  })
})
