import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createServerFetch,
  describeBuildSkew,
  exitOnApiError,
  getApiClient,
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
  const target: ServerTarget = { baseUrl: 'http://127.0.0.1:4242' }

  it('issues requests against the target origin, carrying no credential', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers ?? {}).get('authorization')).toBeNull()
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

  it('surfaces a refused identity in the server\'s own words, without a retry', async () => {
    // Only the 401's message says why (a tagged device, or no tailscale
    // serve), so it is shown verbatim and not retried.
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net' }
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(
      '{"error":{"code":"UNAUTHENTICATED","message":"tailscale serve sent no user identity"}}', 401,
    )))
    const api = getApiClient({
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(api.project.list.$get()).rejects.toThrow('tailscale serve sent no user identity')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('warns once (stderr) when the server reports a different build id', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'local-build')
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net' }
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
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net' }
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
    // A warning, not an error: a local server may be a Deployment on an
    // older bundle, and the warning names the commands that roll it.
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
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('the env hatch wins over a selected server', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: true, saved: [] })
    vi.stubEnv('YAAC_SERVER_URL', 'http://127.0.0.1:1234/')
    expect(await resolveServerTarget())
      .toEqual({ baseUrl: 'http://127.0.0.1:1234' })
  })

  it('resolves the selected server, wherever it runs', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: true, saved: [] })
    expect(await resolveServerTarget()).toEqual({ baseUrl: 'https://srv.ts.net' })
    // A loopback origin takes the same path.
    await writeServerConfig({
      url: 'http://127.0.0.1:8787', enabled: true, saved: [],
      driver: 'containerless',
    })
    expect(await resolveServerTarget())
      .toEqual({ baseUrl: 'http://127.0.0.1:8787' })
  })

  it('a deselected server resolves nothing — there is no fallback to look for one', async () => {
    // With nothing selected the answer is "none" even if a local server is
    // running; clients do not read the lock.
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: false, saved: [] })
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
