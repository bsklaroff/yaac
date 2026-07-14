import { describe, it, expect, vi, beforeEach } from 'vitest'
import { authFake } from '#commands/auth-fake'
import { getApiClient } from '@yaac/shared/server-api'
import { ServerError } from '@yaac/shared/errors'
import type * as serverApiModule from '@yaac/shared/server-api'

// authFake builds its client via the shared factory (it bypasses the
// authUpdate-injecting singleton), so mock the factory itself. It's now
// synchronous, hence mockReturnValue.
vi.mock('@yaac/shared/server-api', async (importOriginal) => {
  const actual = await importOriginal<typeof serverApiModule>()
  return {
    ...actual,
    getApiClient: vi.fn(),
  }
})

function mockClient(post: ReturnType<typeof vi.fn>): void {
  vi.mocked(getApiClient).mockReturnValue({
    auth: { fake: { $post: post } },
  } as unknown as ReturnType<typeof getApiClient>)
}

describe('authFake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('posts kind "claude-oauth" to the server', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    mockClient(post)
    await authFake('claude-oauth')
    expect(post).toHaveBeenCalledWith({ json: { kind: 'claude-oauth' } })
  })

  it('posts kind "github" to the server', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    mockClient(post)
    await authFake('github')
    expect(post).toHaveBeenCalledWith({ json: { kind: 'github' } })
  })

  it('throws when the server returns an error response', async () => {
    // The throwing API client rejects on a non-2xx; the command lets it
    // propagate (no per-call ok check).
    const post = vi.fn().mockRejectedValue(new ServerError('INTERNAL', 'server error'))
    mockClient(post)
    await expect(authFake('github')).rejects.toThrow('server error')
  })
})
