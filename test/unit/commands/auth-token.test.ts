import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import { authTokenCreate, authTokenList, authTokenRevoke } from '@/commands/auth-token'
import { getRpcClient } from '@/shared/server-client'
import type * as serverClientModule from '@/shared/server-client'

vi.mock('@/shared/server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof serverClientModule>()
  return {
    ...actual,
    getRpcClient: vi.fn(),
    toClientError: vi.fn().mockImplementation(async (res: Response) => {
      const body = await res.json() as { error?: { message?: string } }
      return new Error(body.error?.message ?? `server ${res.status}`)
    }),
  }
})

function mockClient(routes: Record<string, unknown>): void {
  vi.mocked(getRpcClient).mockResolvedValue(
    { tokens: routes } as unknown as Awaited<ReturnType<typeof getRpcClient>>,
  )
}

describe('yaac auth token commands', () => {
  let logSpy: MockInstance<typeof console.log>
  let errorSpy: MockInstance<typeof console.error>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('create prints the token to stdout and the warning to stderr', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: 'laptop', token: 'f'.repeat(64), createdAt: 'now' }),
    })
    mockClient({ $post: post })

    await authTokenCreate('laptop')

    expect(post).toHaveBeenCalledWith({ json: { name: 'laptop' } })
    expect(logSpy).toHaveBeenCalledWith('f'.repeat(64))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/shown only once/))
  })

  it('create surfaces the server error', async () => {
    mockClient({
      $post: vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: { code: 'CONFLICT', message: "a token named 'laptop' already exists" } }),
      }),
    })
    await expect(authTokenCreate('laptop')).rejects.toThrow(/already exists/)
  })

  it('list prints masked summaries, or guidance when empty', async () => {
    mockClient({
      $get: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          tokens: [{ name: 'laptop', masked: 'abcd1234…', createdAt: '2026-07-09T00:00:00.000Z' }],
        }),
      }),
    })
    await authTokenList()
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('laptop')
    expect(printed).toContain('abcd1234…')
    expect(printed).toContain('2026-07-09')

    logSpy.mockClear()
    mockClient({ $get: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tokens: [] }) }) })
    await authTokenList()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac auth token create/))
  })

  it('revoke deletes by name and confirms', async () => {
    const del = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    mockClient({ ':name': { $delete: del } })

    await authTokenRevoke('laptop')

    expect(del).toHaveBeenCalledWith({ param: { name: 'laptop' } })
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Revoked token 'laptop'/))
  })
})
