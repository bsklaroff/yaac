import { describe, expect, it, vi } from 'vitest'
import type { ServerTarget } from '@yaac/shared/server-api'
import { mintWebToken } from '#mint'

const TARGET: ServerTarget = { baseUrl: 'http://127.0.0.1:8787', secret: 'sekrit' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mintWebToken', () => {
  it('POSTs a one-time mint with the bearer and returns the token', async () => {
    const seen: { url: string, auth: string | null, body: string | undefined }[] = []
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return Promise.resolve(json({ name: 'web-1', token: 't0ken', kind: 'one-time' }, 201))
    }
    const token = await mintWebToken({ resolveTarget: () => Promise.resolve(TARGET), fetchImpl })
    expect(token).toBe('t0ken')
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`${TARGET.baseUrl}/tokens`)
    expect(seen[0].auth).toBe(`Bearer ${TARGET.secret}`)
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({ kind: 'one-time' })
  })
  it("throws with the server's error message on a non-2xx response", async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.resolve(json({ error: { code: 'UNAUTHENTICATED', message: 'missing or invalid credential' } }, 401))
    await expect(
      mintWebToken({ resolveTarget: () => Promise.resolve(TARGET), fetchImpl }),
    ).rejects.toThrow('missing or invalid credential')
  })
  it('propagates network failures', async () => {
    const fetchImpl: typeof globalThis.fetch = () =>
      Promise.reject(new TypeError('fetch failed'))
    await expect(
      mintWebToken({ resolveTarget: () => Promise.resolve(TARGET), fetchImpl }),
    ).rejects.toThrow('fetch failed')
  })
  it('forces the build-skew warning off — the shell has no build identity', async () => {
    // With a build id injected and a remote target reporting a different
    // one, the shared client would warn on stderr; the shell must not
    // (it has no build identity — the id here belongs to no shell code).
    vi.stubEnv('YAAC_BUILD_ID', 'shell-build')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok' }
    const fetchImpl: typeof globalThis.fetch = () => Promise.resolve(
      new Response(JSON.stringify({ name: 'web-1', token: 't0ken', kind: 'one-time' }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-yaac-build-id': 'server-build' },
      }),
    )
    const token = await mintWebToken({ resolveTarget: () => Promise.resolve(remote), fetchImpl })
    expect(token).toBe('t0ken')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
    vi.unstubAllEnvs()
  })
})
