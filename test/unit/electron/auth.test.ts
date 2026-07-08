import { describe, it, expect, vi } from 'vitest'
import { buildAuthedRendererUrl, fetchBootstrapCode } from '@/electron/auth'

describe('buildAuthedRendererUrl', () => {
  it('adds the bootstrap code to the daemon origin', () => {
    expect(buildAuthedRendererUrl('http://127.0.0.1:8787/', 'abc'))
      .toBe('http://127.0.0.1:8787/?bootstrap=abc')
  })
  it('adds the code to a dev Vite URL, preserving the host', () => {
    expect(buildAuthedRendererUrl('http://localhost:1420/', 'xyz'))
      .toBe('http://localhost:1420/?bootstrap=xyz')
  })
  it('url-encodes a code with reserved characters', () => {
    expect(buildAuthedRendererUrl('http://127.0.0.1:8787/', 'a b&c'))
      .toBe('http://127.0.0.1:8787/?bootstrap=a+b%26c')
  })
})

describe('fetchBootstrapCode', () => {
  const res = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }) as unknown as Response

  it('sends the bearer and returns the code', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(res(200, { code: 'boot123' })))
    const code = await fetchBootstrapCode(8787, 'secret', fetchImpl as unknown as typeof fetch)
    expect(code).toBe('boot123')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/auth/bootstrap-code')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
  })
  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(res(401, {})))
    await expect(fetchBootstrapCode(8787, 's', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/HTTP 401/)
  })
  it('throws when the daemon returns an empty code', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(res(200, { code: '' })))
    await expect(fetchBootstrapCode(8787, 's', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/empty bootstrap code/)
  })
})
