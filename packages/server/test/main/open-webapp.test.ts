import { describe, it, expect, vi } from 'vitest'
import { buildWebappUrl, openWebapp } from '#main/webapp'
import type { ServerTarget } from '@yaac/shared/server-api'

describe('buildWebappUrl', () => {
  it('builds a URL on the target origin carrying the exchange token', () => {
    expect(buildWebappUrl('http://127.0.0.1:54213', 'abc123'))
      .toBe('http://127.0.0.1:54213/?token=abc123')
    expect(buildWebappUrl('https://srv.tailnet.ts.net', 't0k3n'))
      .toBe('https://srv.tailnet.ts.net/?token=t0k3n')
  })

  it('builds a bare URL when there is no token (credential-optional server)', () => {
    expect(buildWebappUrl('http://127.0.0.1:54213', null))
      .toBe('http://127.0.0.1:54213/')
  })
})

const local: ServerTarget = { baseUrl: 'http://127.0.0.1:9999', secret: 's', remote: false }
const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true }

/**
 * Routes by URL: `/health` reports `authRequired` (default true), `/tokens`
 * mints `token`. Mirrors the real two-step flow `openWebapp` now performs.
 */
function fakeFetch(opts: { token?: string; authRequired?: boolean } = {}): typeof fetch {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).endsWith('/health')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, authRequired: opts.authRequired ?? true }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: opts.token ?? 'TOKEN' }) })
  }) as unknown as typeof fetch
}

function tokensCall(fetchImpl: typeof fetch): [string, RequestInit] | undefined {
  const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][]
  return calls.find((c) => String(c[0]).endsWith('/tokens'))
}

describe('openWebapp', () => {
  it('mints a one-time token and launches the browser with the authed URL', async () => {
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openWebapp({
      ensureServer: () => Promise.resolve(),
      resolveTarget: () => Promise.resolve(local),
      fetchImpl: fakeFetch({ token: 'TOKEN123' }),
      launch,
    })
    expect(launch).toHaveBeenCalledWith('http://127.0.0.1:9999/?token=TOKEN123')
    expect(logSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/?token=TOKEN123')
    logSpy.mockRestore()
  })

  it('skips the token when the server does not require a credential', async () => {
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = fakeFetch({ authRequired: false })
    await openWebapp({
      ensureServer: () => Promise.resolve(),
      resolveTarget: () => Promise.resolve(local),
      fetchImpl,
      launch,
    })
    // Bare URL, and /tokens was never hit.
    expect(launch).toHaveBeenCalledWith('http://127.0.0.1:9999/')
    expect(logSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/')
    expect(tokensCall(fetchImpl)).toBeUndefined()
    logSpy.mockRestore()
  })

  it('mints the token when /health is unreachable or omits the field (fail-safe)', async () => {
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // /health throws; openWebapp must default to requiring a credential.
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/health')) return Promise.reject(new Error('refused'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'FALLBACK' }) })
    }) as unknown as typeof fetch
    await openWebapp({
      ensureServer: () => Promise.resolve(),
      resolveTarget: () => Promise.resolve(local),
      fetchImpl,
      launch,
    })
    expect(launch).toHaveBeenCalledWith('http://127.0.0.1:9999/?token=FALLBACK')
    logSpy.mockRestore()
  })

  it('with noBrowser, prints the URL but does not launch a browser', async () => {
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openWebapp({
      noBrowser: true,
      ensureServer: () => Promise.resolve(),
      resolveTarget: () => Promise.resolve(local),
      fetchImpl: fakeFetch({ token: 'X' }),
      launch,
    })
    expect(launch).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/?token=X')
    logSpy.mockRestore()
  })

  it('a resolved remote target skips ensureServer and mints via POST /tokens', async () => {
    const ensureServer = vi.fn().mockResolvedValue(undefined)
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = fakeFetch({ token: 'R' })
    await openWebapp({
      ensureServer,
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl,
      launch,
    })
    expect(ensureServer).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith('https://srv.ts.net/?token=R')
    const call = tokensCall(fetchImpl)!
    expect(call[0]).toBe('https://srv.ts.net/tokens')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body as string)).toEqual({ kind: 'one-time' })
    expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer tok')
    logSpy.mockRestore()
  })

  it('auto-starts the local server when resolution fails, then re-resolves', async () => {
    const ensureServer = vi.fn().mockResolvedValue(undefined)
    const resolveTarget = vi.fn()
      .mockRejectedValueOnce(new Error('yaac server is not running'))
      .mockResolvedValueOnce(local)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openWebapp({
      noBrowser: true,
      ensureServer,
      resolveTarget,
      fetchImpl: fakeFetch({ token: 'Y' }),
    })
    expect(ensureServer).toHaveBeenCalledTimes(1)
    expect(resolveTarget).toHaveBeenCalledTimes(2)
    logSpy.mockRestore()
  })

  it('surfaces the resolution error when the server still is not up', async () => {
    await expect(openWebapp({
      ensureServer: () => Promise.resolve(),
      resolveTarget: () => Promise.reject(new Error('yaac server is not running. Start it with: yaac server start')),
    })).rejects.toThrow(/not running/)
  })
})
