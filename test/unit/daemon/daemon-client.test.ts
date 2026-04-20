import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  DaemonClientError,
  exitOnClientError,
  getClient,
} from '@/lib/daemon-client'

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

describe('DaemonClientError', () => {
  it('preserves code + message', () => {
    const err = new DaemonClientError('NOT_FOUND', 'project foo not found')
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('project foo not found')
    expect(err.name).toBe('DaemonClientError')
  })
})

describe('getClient', () => {
  const lock = { pid: 1, port: 4242, secret: 'shh', startedAt: 0 }

  it('issues a GET with the bearer header from the lock', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? {}).get('authorization')
      expect(auth).toBe('Bearer shh')
      return Promise.resolve(jsonResponse('[]'))
    })
    const client = await getClient({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(await client.get('/project/list')).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toBe('http://127.0.0.1:4242/project/list')
  })

  it('on 401 re-resolves the lock and retries once', async () => {
    const newLock = { ...lock, secret: 'rotated', port: 4243 }
    const resolveLock = vi.fn()
      .mockResolvedValueOnce(lock)
      .mockResolvedValueOnce(newLock)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('{"error":{"code":"AUTH_REQUIRED","message":"x"}}', 401))
      .mockResolvedValueOnce(jsonResponse('[]'))
    const client = await getClient({ resolveLock, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.get('/project/list')).toEqual([])
    expect(resolveLock).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const second = fetchImpl.mock.calls[1] as [string, RequestInit]
    const auth = new Headers(second[1].headers ?? {}).get('authorization')
    expect(auth).toBe('Bearer rotated')
    expect(second[0]).toBe('http://127.0.0.1:4243/project/list')
  })

  it('throws DaemonClientError with the daemon-supplied code', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(
      '{"error":{"code":"NOT_FOUND","message":"project foo"}}',
      404,
    )))
    const client = await getClient({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.get('/project/missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'project foo',
    })
  })

  it('falls back to INTERNAL when the daemon returns a non-JSON error', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('not json', { status: 502 })))
    const client = await getClient({
      resolveLock: () => Promise.resolve(lock),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.get('/x')).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'daemon returned 502',
    })
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

  it('exits 2 for VALIDATION', () => {
    expect(() => exitOnClientError(new DaemonClientError('VALIDATION', 'bad input'))).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(errorSpy).toHaveBeenCalledWith('bad input')
  })

  it('exits 1 for NOT_FOUND', () => {
    expect(() => exitOnClientError(new DaemonClientError('NOT_FOUND', 'missing'))).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits 1 for an unknown error type', () => {
    expect(() => exitOnClientError(new Error('boom'))).toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith('boom')
  })
})
