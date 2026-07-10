import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createServerFetch,
  describeBuildSkew,
  describeLockMismatch,
  exitOnClientError,
  resolveServerTarget,
  toClientError,
  type ServerTarget,
} from '@/shared/server-client'
import { writeRemote } from '@/shared/remote'
import { setDataDir } from '@/shared/paths'

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('createServerFetch', () => {
  const target: ServerTarget = { baseUrl: 'http://127.0.0.1:4242', secret: 'shh', remote: false }

  it('issues requests against the target origin with the bearer header', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? {}).get('authorization')
      expect(auth).toBe('Bearer shh')
      return Promise.resolve(jsonResponse('[]'))
    })
    const serverFetch = await createServerFetch({
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
    const serverFetch = await createServerFetch({
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

  it('a persistent BAD_BEARER on a remote target throws token-refresh instructions', async () => {
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true }
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('{"error":{"code":"BAD_BEARER","message":"x"}}', 401),
    ))
    const serverFetch = await createServerFetch({
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(serverFetch('/project/list')).rejects.toThrow(
      /rejected the token.*yaac auth token create.*yaac remote set https:\/\/srv\.ts\.net/s,
    )
    // No blind retry with the same credential.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('warns once (stderr) when a remote server reports a different build id', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'local-build')
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = await createServerFetch({
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

  it('does not warn about build skew for local targets', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = await createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await serverFetch('/project/list')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockClear()
  })

  it('on AUTH_REQUIRED invokes onAuthRequired and retries once', async () => {
    const onAuthRequired = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(
        '{"error":{"code":"AUTH_REQUIRED","message":"need login"}}',
        401,
      ))
      .mockResolvedValueOnce(jsonResponse('{"ok":true}'))
    const serverFetch = await createServerFetch({
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
    const serverFetch = await createServerFetch({
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
    const serverFetch = await createServerFetch({
      resolveTarget: () => Promise.resolve(target),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await serverFetch('http://server.local/project/list?foo=bar')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4242/project/list?foo=bar')
  })
})

describe('resolveServerTarget', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-target-'))
    setDataDir(dir)
    vi.stubEnv('YAAC_SERVER_URL', undefined)
    vi.stubEnv('YAAC_SERVER_SECRET', undefined)
    // The local-lock branch compares build ids before reading the lock;
    // a source checkout has no .build-id file, so inject one.
    vi.stubEnv('YAAC_BUILD_ID', 'test-build')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('the env hatch wins over an enabled remote', async () => {
    await writeRemote({ url: 'https://srv.ts.net', token: 'tok', enabled: true })
    vi.stubEnv('YAAC_SERVER_URL', 'http://127.0.0.1:1234/')
    vi.stubEnv('YAAC_SERVER_SECRET', 'env-secret')
    const target = await resolveServerTarget()
    expect(target).toEqual({ baseUrl: 'http://127.0.0.1:1234', secret: 'env-secret', remote: false })
  })

  it('an enabled remote wins over the local lock', async () => {
    await writeRemote({ url: 'https://srv.ts.net', token: 'tok', enabled: true })
    const target = await resolveServerTarget()
    expect(target).toEqual({ baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true })
  })

  it('a disabled remote falls through to the local lock path', async () => {
    await writeRemote({ url: 'https://srv.ts.net', token: 'tok', enabled: false })
    // No lock in the temp data dir → the local branch throws its
    // "not running" guidance, proving the remote was skipped.
    await expect(resolveServerTarget()).rejects.toThrow(/yaac server start/)
  })

  it('with no remote at all, the local lock path is used', async () => {
    await expect(resolveServerTarget()).rejects.toThrow(/not running/)
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

describe('describeLockMismatch', () => {
  const lock = { pid: 1, port: 4242, secret: 'shh', startedAt: 0, buildId: 'abc' }

  it('returns a "not running" message when there is no lock', () => {
    const msg = describeLockMismatch(null, false, 'abc')
    expect(msg).toMatch(/not running/)
    expect(msg).toMatch(/yaac server start/)
  })

  it('returns a "not running" message when the lock is stale (not live)', () => {
    const msg = describeLockMismatch(lock, false, 'abc')
    expect(msg).toMatch(/not running/)
    expect(msg).toMatch(/yaac server start/)
  })

  it('returns a version-mismatch message when buildIds differ', () => {
    const msg = describeLockMismatch(lock, true, 'xyz')
    expect(msg).toMatch(/outdated version/)
    expect(msg).toMatch(/abc/)
    expect(msg).toMatch(/xyz/)
    expect(msg).toMatch(/yaac server restart/)
  })

  it('returns null when the live server matches the CLI buildId', () => {
    expect(describeLockMismatch(lock, true, 'abc')).toBeNull()
  })
})

describe('toClientError', () => {
  it('extracts the server-supplied message from a JSON error body', async () => {
    const res = new Response('{"error":{"code":"NOT_FOUND","message":"project foo"}}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
    const err = await toClientError(res)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('project foo')
  })

  it('falls back to a status-carrying message when the body is not JSON', async () => {
    const res = new Response('not json', { status: 502 })
    const err = await toClientError(res)
    expect(err.message).toBe('server returned 502')
  })
})

describe('exitOnClientError', () => {
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
    expect(() => exitOnClientError(new Error('boom'))).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith('boom')
  })

  it('stringifies non-Error rejections', () => {
    expect(() => exitOnClientError('oops')).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith('oops')
  })
})
