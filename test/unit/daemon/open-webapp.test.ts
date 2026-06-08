import { describe, it, expect, vi } from 'vitest'
import { buildWebappUrl, openWebapp } from '@/daemon/cli'
import type { DaemonLock } from '@/shared/lock'

describe('buildWebappUrl', () => {
  it('builds a loopback URL carrying the bootstrap code', () => {
    expect(buildWebappUrl(54213, 'abc123')).toBe('http://127.0.0.1:54213/?bootstrap=abc123')
  })
})

const lock: DaemonLock = { pid: 1, port: 9999, secret: 's', startedAt: 0, buildId: 'b' }

function fakeFetch(code: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ code }),
  }) as unknown as typeof fetch
}

describe('openWebapp', () => {
  it('fetches a code and launches the browser with the authed URL', async () => {
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openWebapp({
      ensureDaemon: () => Promise.resolve(),
      loadLock: () => Promise.resolve(lock),
      fetchImpl: fakeFetch('CODE123'),
      launch,
    })
    expect(launch).toHaveBeenCalledWith('http://127.0.0.1:9999/?bootstrap=CODE123')
    expect(logSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/?bootstrap=CODE123')
    logSpy.mockRestore()
  })

  it('with noBrowser, prints the URL but does not launch a browser', async () => {
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openWebapp({
      noBrowser: true,
      ensureDaemon: () => Promise.resolve(),
      loadLock: () => Promise.resolve(lock),
      fetchImpl: fakeFetch('X'),
      launch,
    })
    expect(launch).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/?bootstrap=X')
    logSpy.mockRestore()
  })

  it('throws when no daemon lock is present', async () => {
    await expect(openWebapp({
      ensureDaemon: () => Promise.resolve(),
      loadLock: () => Promise.resolve(null),
    })).rejects.toThrow(/not running/)
  })
})
