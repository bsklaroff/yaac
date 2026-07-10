import { describe, it, expect, vi, beforeEach } from 'vitest'
import { authFake } from '@yaac/cli/commands/auth-fake'
import { getRpcClient } from '@yaac/shared/server-client'
import type * as serverClientModule from '@yaac/shared/server-client'

vi.mock('@yaac/shared/server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof serverClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
    toClientError: vi.fn().mockResolvedValue(new Error('server error')),
  }
})

function mockClient(post: ReturnType<typeof vi.fn>): void {
  vi.mocked(getRpcClient).mockResolvedValue({
    auth: { fake: { $post: post } },
  } as unknown as Awaited<ReturnType<typeof getRpcClient>>)
}

describe('authFake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('posts kind "claude-oauth" to the server', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    mockClient(post)
    await authFake('claude-oauth')
    expect(post).toHaveBeenCalledWith({ json: { kind: 'claude-oauth' } })
  })

  it('posts kind "github" to the server', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    mockClient(post)
    await authFake('github')
    expect(post).toHaveBeenCalledWith({ json: { kind: 'github' } })
  })

  it('throws when the server returns an error response', async () => {
    const post = vi.fn().mockResolvedValue({ ok: false })
    mockClient(post)
    await expect(authFake('github')).rejects.toThrow('server error')
  })
})
