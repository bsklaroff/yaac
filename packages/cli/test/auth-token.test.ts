import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { authTokenCreate, authTokenList, authTokenRevoke } from '#commands/auth-token'
import { ServerError } from '@yaac/shared/errors'

// The commands use the shared `api` singleton; mock it so the leaf request
// methods resolve to already-unwrapped bodies (the real client unwraps).
const { post, get, del } = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}))

vi.mock('#commands/api', () => ({
  api: { tokens: { $post: post, $get: get, [':name']: { $delete: del } } },
}))

describe('yaac auth token commands', () => {
  let logSpy: MockInstance<typeof console.log>
  let errorSpy: MockInstance<typeof console.error>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('create prints the token to stdout and the warning to stderr', async () => {
    post.mockResolvedValue({ name: 'laptop', token: 'f'.repeat(64), createdAt: 'now' })

    await authTokenCreate('laptop')

    expect(post).toHaveBeenCalledWith({ json: { name: 'laptop' } })
    expect(logSpy).toHaveBeenCalledWith('f'.repeat(64))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/shown only once/))
  })

  it('create surfaces the server error', async () => {
    post.mockRejectedValue(new ServerError('CONFLICT', "a token named 'laptop' already exists"))
    await expect(authTokenCreate('laptop')).rejects.toThrow(/already exists/)
  })

  it('list prints masked summaries, or guidance when empty', async () => {
    get.mockResolvedValue({
      tokens: [{ name: 'laptop', kind: 'durable', masked: 'abcd1234…', createdAt: '2026-07-09T00:00:00.000Z' }],
    })
    await authTokenList()
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('laptop')
    expect(printed).toContain('durable')
    expect(printed).toContain('abcd1234…')
    expect(printed).toContain('2026-07-09')

    logSpy.mockClear()
    get.mockResolvedValue({ tokens: [] })
    await authTokenList()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac auth token create/))
  })

  it('revoke deletes by name and confirms', async () => {
    del.mockResolvedValue(undefined)

    await authTokenRevoke('laptop')

    expect(del).toHaveBeenCalledWith({ param: { name: 'laptop' } })
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Revoked token 'laptop'/))
  })
})
