import { describe, it, expect, vi, beforeEach } from 'vitest'
import { authFake } from '#commands/auth-fake'
import { getRpcClient } from '@yaac/shared/server-client'
import { ServerError } from '@yaac/shared/errors'
import type * as serverClientModule from '@yaac/shared/server-client'

vi.mock('@yaac/shared/server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof serverClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
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
    // The throwing RPC client rejects on a non-2xx; the command lets it
    // propagate (no per-call ok check).
    const post = vi.fn().mockRejectedValue(new ServerError('INTERNAL', 'server error'))
    mockClient(post)
    await expect(authFake('github')).rejects.toThrow('server error')
  })
})
