import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  createDaemonFetch,
  describeLockMismatch,
  exitOnClientError,
  toClientError,
} from '@/shared/daemon-client'

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

describe('createDaemonFetch', () => {
  const lock = { pid: 1, port: 4242, secret: 'shh', startedAt: 0, buildId: 'test' }

  it('issues requests against the locked port with the bearer header', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? {}).get('authorization')
      expect(auth).toBe('Bearer shh')
      return Promise.resolve(jsonResponse('[]'))
    })
    const daemonFetch = await createDaemonFetch({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await daemonFetch('/project/list')
    expect(await res.json()).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('http://127.0.0.1:4242/project/list')
  })

  it('on BAD_BEARER re-resolves the lock and retries once', async () => {
    const newLock = { ...lock, secret: 'rotated', port: 4243 }
    const resolveLock = vi.fn()
      .mockResolvedValueOnce(lock)
      .mockResolvedValueOnce(newLock)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('{"error":{"code":"BAD_BEARER","message":"x"}}', 401))
      .mockResolvedValueOnce(jsonResponse('[]'))
    const daemonFetch = await createDaemonFetch({
      resolveLock,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await daemonFetch('/project/list')
    expect(await res.json()).toEqual([])
    expect(resolveLock).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const second = fetchImpl.mock.calls[1] as [string, RequestInit]
    const auth = new Headers(second[1].headers ?? {}).get('authorization')
    expect(auth).toBe('Bearer rotated')
    expect(second[0]).toBe('http://127.0.0.1:4243/project/list')
  })

  it('on AUTH_REQUIRED invokes onAuthRequired and retries once', async () => {
    const onAuthRequired = vi.fn().mockResolvedValue(undefined)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(
        '{"error":{"code":"AUTH_REQUIRED","message":"need login"}}',
        401,
      ))
      .mockResolvedValueOnce(jsonResponse('{"ok":true}'))
    const daemonFetch = await createDaemonFetch({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAuthRequired,
    })
    const res = await daemonFetch('/auth/github/tokens', { method: 'POST' })
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
    const daemonFetch = await createDaemonFetch({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onAuthRequired,
    })
    const res = await daemonFetch('/tool/default')
    expect(res.status).toBe(401)
    expect(res.ok).toBe(false)
    expect(onAuthRequired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('accepts a full URL input and uses only path+search', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse('[]')),
    )
    const daemonFetch = await createDaemonFetch({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await daemonFetch('http://daemon.local/project/list?foo=bar')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:4242/project/list?foo=bar')
  })
})

describe('describeLockMismatch', () => {
  const lock = { pid: 1, port: 4242, secret: 'shh', startedAt: 0, buildId: 'abc' }

  it('returns a "not running" message when there is no lock', () => {
    const msg = describeLockMismatch(null, false, 'abc')
    expect(msg).toMatch(/not running/)
    expect(msg).toMatch(/yaac daemon start/)
  })

  it('returns a "not running" message when the lock is stale (not live)', () => {
    const msg = describeLockMismatch(lock, false, 'abc')
    expect(msg).toMatch(/not running/)
    expect(msg).toMatch(/yaac daemon start/)
  })

  it('returns a version-mismatch message when buildIds differ', () => {
    const msg = describeLockMismatch(lock, true, 'xyz')
    expect(msg).toMatch(/outdated version/)
    expect(msg).toMatch(/abc/)
    expect(msg).toMatch(/xyz/)
    expect(msg).toMatch(/yaac daemon restart/)
  })

  it('returns null when the live daemon matches the CLI buildId', () => {
    expect(describeLockMismatch(lock, true, 'abc')).toBeNull()
  })
})

describe('toClientError', () => {
  it('extracts the daemon-supplied message from a JSON error body', async () => {
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
    expect(err.message).toBe('daemon returned 502')
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
