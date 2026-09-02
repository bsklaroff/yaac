import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createServerFetch,
  describeBuildSkew,
  exitOnApiError,
  isLoopbackOrigin,
  resolveServerTarget,
  type ServerTarget,
} from '#server-api'
import { writeServerConfig } from '#server-config'
import { setDataDir } from '#paths'

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('createServerFetch', () => {
  const target: ServerTarget = { baseUrl: 'http://127.0.0.1:4242', secret: 'shh' }

  it('issues requests against the target origin with the bearer header', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? {}).get('authorization')
      expect(auth).toBe('Bearer shh')
      return Promise.resolve(jsonResponse('[]'))
    })
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await serverFetch('/project/list')
    expect(await res.json()).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('http://127.0.0.1:4242/project/list')
  })

  it('on BAD_BEARER re-resolves the target and retries once', async () => {
    const rotated: ServerTarget = { ...target, secret: 'rotated', baseUrl: 'http://127.0.0.1:4243' }
    const resolveTarget = vi.fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(rotated)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('{"error":{"code":"BAD_BEARER","message":"x"}}', 401))
      .mockResolvedValueOnce(jsonResponse('[]'))
    const serverFetch = createServerFetch({
      resolveTarget,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await serverFetch('/project/list')
    expect(await res.json()).toEqual([])
    expect(resolveTarget).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const second = fetchImpl.mock.calls[1] as [string, RequestInit]
    const auth = new Headers(second[1].headers ?? {}).get('authorization')
    expect(auth).toBe('Bearer rotated')
    expect(second[0]).toBe('http://127.0.0.1:4243/project/list')
  })

  it('a persistent BAD_BEARER throws token-refresh instructions for either kind of server', async () => {
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok' }
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('{"error":{"code":"BAD_BEARER","message":"x"}}', 401),
    ))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(serverFetch('/project/list')).rejects.toThrow(
      /rejected the token.*yaac server start.*yaac auth token create.*yaac remote set https:\/\/srv\.ts\.net/s,
    )
    // No blind retry with the same credential.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('warns once (stderr) when the server reports a different build id', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'local-build')
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok' }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await serverFetch('/project/list')
    await serverFetch('/project/list')
    const skewCalls = errorSpy.mock.calls.filter((c) => /differs from this CLI/.test(String(c[0])))
    expect(skewCalls).toHaveLength(1)
    errorSpy.mockClear()
    vi.unstubAllEnvs()
  })

  it('warnOnBuildSkew: false suppresses the build-skew warning', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'local-build')
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok' }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      warnOnBuildSkew: false,
    })
    await serverFetch('/project/list')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockClear()
    vi.unstubAllEnvs()
  })

  it('warns about build skew on a server on THIS machine too, naming its fix', async () => {
    // Never an error on the request path: a server on this machine can be a
    // Deployment carrying an older bundle, and the commands that roll it are
    // what the warning has to name.
    vi.stubEnv('YAAC_BUILD_ID', 'local-build')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await serverFetch('/project/list')
    expect(res.status).toBe(200)
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/yaac server restart.*yaac cluster install/)
    errorSpy.mockClear()
    vi.unstubAllEnvs()
  })

  it('on AUTH_REQUIRED invokes onAuthRequired and retries once', async () => {
    const onAuthRequired = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(
        '{"error":{"code":"AUTH_REQUIRED","message":"need login"}}',
        401,
      ))
      .mockResolvedValueOnce(jsonResponse('{"ok":true}'))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAuthRequired,
    })
    const res = await serverFetch('/auth/github/tokens', { method: 'POST' })
    expect(await res.json()).toEqual({ ok: true })
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns a second AUTH_REQUIRED response unchanged for the caller to surface', async () => {
    const onAuthRequired = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(
      '{"error":{"code":"AUTH_REQUIRED","message":"still need login"}}',
      401,
    )))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAuthRequired,
    })
    const res = await serverFetch('/tool/default')
    expect(res.status).toBe(401)
    expect(res.ok).toBe(false)
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('accepts a full URL input and uses only path+search', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse('[]')),
    )
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await serverFetch('http://server.local/project/list?foo=bar')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4242/project/list?foo=bar')
  })
})

describe('isLoopbackOrigin', () => {
  it('answers "this machine" for every loopback spelling', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:8787')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:8787')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:8787')).toBe(true)
  })

  it('answers no for a named host, and for anything unparseable', () => {
    expect(isLoopbackOrigin('https://srv.example.ts.net')).toBe(false)
    expect(isLoopbackOrigin('not a url')).toBe(false)
  })
})

describe('resolveServerTarget', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-target-'))
    setDataDir(dir)
    vi.stubEnv('YAAC_SERVER_URL', undefined)
    vi.stubEnv('YAAC_SERVER_SECRET', undefined)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('the env hatch wins over a selected server', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', token: 'tok', enabled: true, saved: [] })
    vi.stubEnv('YAAC_SERVER_URL', 'http://127.0.0.1:1234/')
    vi.stubEnv('YAAC_SERVER_SECRET', 'env-secret')
    expect(await resolveServerTarget())
      .toEqual({ baseUrl: 'http://127.0.0.1:1234', secret: 'env-secret' })
  })

  it('resolves the selected server, wherever it runs', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', token: 'tok', enabled: true, saved: [] })
    expect(await resolveServerTarget()).toEqual({ baseUrl: 'https://srv.ts.net', secret: 'tok' })
    // A server on this machine is resolved the same way — the origin being
    // loopback is not a different code path.
    await writeServerConfig({
      url: 'http://127.0.0.1:8787', token: 'local-tok', enabled: true, saved: [],
      driver: 'containerless',
    })
    expect(await resolveServerTarget())
      .toEqual({ baseUrl: 'http://127.0.0.1:8787', secret: 'local-tok' })
  })

  it('a deselected server resolves nothing — there is no fallback to look for one', async () => {
    // A live server could well be listening on this machine right now; with
    // nothing selected the answer is still "none", because the lock is not a
    // client's to read.
    await writeServerConfig({ url: 'https://srv.ts.net', token: 'tok', enabled: false, saved: [] })
    await expect(resolveServerTarget()).rejects.toThrow(/No yaac server selected/)
  })

  it('with no config at all, names all three ways to get one', async () => {
    await expect(resolveServerTarget()).rejects.toThrow(
      /yaac server start.*yaac cluster install.*yaac remote set/s,
    )
  })
})

describe('describeBuildSkew', () => {
  it('is null when the ids match or the server did not report one', () => {
    expect(describeBuildSkew('abc', 'abc')).toBeNull()
    expect(describeBuildSkew(null, 'abc')).toBeNull()
    expect(describeBuildSkew('', 'abc')).toBeNull()
  })

  it('describes a mismatch with both ids', () => {
    const msg = describeBuildSkew('remote-x', 'local-y')
    expect(msg).toMatch(/remote-x/)
    expect(msg).toMatch(/local-y/)
    expect(msg).toMatch(/^warning:/)
  })
})

describe('exitOnApiError', () => {
  const exitSpy = vi.spyOn(process, 'exit')
  const errorSpy = vi.spyOn(console, 'error')

  beforeAll(() => {
    exitSpy.mockImplementation(((_code?: number) => {
      throw new Error('process.exit called')
    }) as never)
    errorSpy.mockImplementation(() => {})
  })

  beforeEach(() => {
    exitSpy.mockClear()
    errorSpy.mockClear()
  })

  afterAll(() => {
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('prints the message and exits 1 for any Error', () => {
    expect(() => exitOnApiError(new Error('boom'))).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith('boom')
  })

  it('stringifies non-Error rejections', () => {
    expect(() => exitOnApiError('oops')).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith('oops')
  })
})
