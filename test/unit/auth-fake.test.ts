import { describe, it, expect, vi, beforeEach } from 'vitest'
import { authFake } from '@/commands/auth-fake'
import { getRpcClient } from '@/shared/daemon-client'
import type * as daemonClientModule from '@/shared/daemon-client'

vi.mock('@/shared/daemon-client', async (importOriginal) => {
  const actual = await importOriginal<typeof daemonClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
    toClientError: vi.fn().mockResolvedValue(new Error('daemon error')),
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

  it('posts kind "claude-oauth" to the daemon', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    mockClient(post)
    await authFake('claude-oauth')
    expect(post).toHaveBeenCalledWith({ json: { kind: 'claude-oauth' } })
  })

  it('posts kind "github" to the daemon', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    mockClient(post)
    await authFake('github')
    expect(post).toHaveBeenCalledWith({ json: { kind: 'github' } })
  })

  it('throws on an unknown kind without calling the daemon', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true })
    mockClient(post)
    await expect(authFake('bogus')).rejects.toThrow(/Unknown fake credential kind/)
    expect(post).not.toHaveBeenCalled()
  })

  it('throws when the daemon returns an error response', async () => {
    const post = vi.fn().mockResolvedValue({ ok: false })
    mockClient(post)
    await expect(authFake('github')).rejects.toThrow('daemon error')
  })
})
