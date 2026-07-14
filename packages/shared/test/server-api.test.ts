import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createServerFetch,
  describeBuildSkew,
  describeLockMismatch,
  exitOnApiError,
  resolveServerTarget,
  type ServerTarget,
} from '#server-api'
import { writeLock } from '#lock'
import { writeRemote } from '#remote'
import { setDataDir } from '#paths'

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

  it('a persistent BAD_BEARER on a remote target throws token-refresh instructions', async () => {
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true }
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('{"error":{"code":"BAD_BEARER","message":"x"}}', 401),
    ))
    const serverFetch = createServerFetch({
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

  it('requireBuildMatch: false suppresses the remote build-skew warning', async () => {
    vi.stubEnv('YAAC_BUILD_ID', 'local-build')
    const remote: ServerTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = createServerFetch({
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requireBuildMatch: false,
    })
    await serverFetch('/project/list')
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockClear()
    vi.unstubAllEnvs()
  })

  it('does not warn about build skew for local targets', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(() => Promise.resolve(
      jsonResponse('[]', 200, { 'x-yaac-build-id': 'other-build' }),
    ))
    const serverFetch = createServerFetch({
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

  // A live lock needs a real pid and a /health responder; this process's
  // pid plus a throwaway HTTP server satisfy isLockLive.
  async function startHealthServer(): Promise<{ port: number, close: () => Promise<void> }> {
    const srv = http.createServer((_req, res) => {
      res.statusCode = 200
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as AddressInfo).port
    return {
      port,
      close: () => new Promise((resolve) => srv.close(() => resolve())),
    }
  }

  it('by default rejects a live lock whose buildId differs', async () => {
    const { port, close } = await startHealthServer()
    try {
      await writeLock({ pid: process.pid, port, secret: 'shh', startedAt: 1, buildId: 'other-build' })
      await expect(resolveServerTarget()).rejects.toThrow(/outdated version/)
    } finally {
      await close()
    }
  })

  it('requireBuildMatch: false accepts any live lock without reading a build id', async () => {
    // No injected build id: the default path would throw "broken install"
    // before even reading the lock; client-only mode must never need one.
    vi.stubEnv('YAAC_BUILD_ID', undefined)
    const { port, close } = await startHealthServer()
    try {
      await writeLock({ pid: process.pid, port, secret: 'shh', startedAt: 1, buildId: 'someone-elses-build' })
      const target = await resolveServerTarget({ requireBuildMatch: false })
      expect(target).toEqual({ baseUrl: `http://127.0.0.1:${port}`, secret: 'shh', remote: false })
    } finally {
      await close()
    }
  })

  it('requireBuildMatch: false still requires a live lock', async () => {
    vi.stubEnv('YAAC_BUILD_ID', undefined)
    await expect(resolveServerTarget({ requireBuildMatch: false })).rejects.toThrow(/not running/)
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

  it('a null cliBuildId skips the version comparison (client-only caller)', () => {
    expect(describeLockMismatch(lock, true, null)).toBeNull()
  })

  it('a null cliBuildId still reports a dead server', () => {
    const msg = describeLockMismatch(lock, false, null)
    expect(msg).toMatch(/not running/)
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
