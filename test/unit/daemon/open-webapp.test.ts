import { describe, it, expect, vi } from 'vitest'
import { buildWebappUrl, openWebapp } from '@/daemon/cli'
import type { DaemonTarget } from '@/shared/daemon-client'

describe('buildWebappUrl', () => {
  it('builds a URL on the target origin carrying the bootstrap code', () => {
    expect(buildWebappUrl('http://127.0.0.1:54213', 'abc123'))
      .toBe('http://127.0.0.1:54213/?bootstrap=abc123')
    expect(buildWebappUrl('https://srv.tailnet.ts.net', 'c0de'))
      .toBe('https://srv.tailnet.ts.net/?bootstrap=c0de')
  })
})

const local: DaemonTarget = { baseUrl: 'http://127.0.0.1:9999', secret: 's', remote: false }
const remote: DaemonTarget = { baseUrl: 'https://srv.ts.net', secret: 'tok', remote: true }

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
      resolveTarget: () => Promise.resolve(local),
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
      resolveTarget: () => Promise.resolve(local),
      fetchImpl: fakeFetch('X'),
      launch,
    })
    expect(launch).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('http://127.0.0.1:9999/?bootstrap=X')
    logSpy.mockRestore()
  })

  it('a resolved remote target skips ensureDaemon and uses the remote origin', async () => {
    const ensureDaemon = vi.fn().mockResolvedValue(undefined)
    const launch = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = fakeFetch('R')
    await openWebapp({
      ensureDaemon,
      resolveTarget: () => Promise.resolve(remote),
      fetchImpl,
      launch,
    })
    expect(ensureDaemon).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledWith('https://srv.ts.net/?bootstrap=R')
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('https://srv.ts.net/auth/bootstrap-code')
    expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer tok')
    logSpy.mockRestore()
  })

  it('auto-starts the local daemon when resolution fails, then re-resolves', async () => {
    const ensureDaemon = vi.fn().mockResolvedValue(undefined)
    const resolveTarget = vi.fn()
      .mockRejectedValueOnce(new Error('yaac daemon is not running'))
      .mockResolvedValueOnce(local)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await openWebapp({
      noBrowser: true,
      ensureDaemon,
      resolveTarget,
      fetchImpl: fakeFetch('Y'),
    })
    expect(ensureDaemon).toHaveBeenCalledTimes(1)
    expect(resolveTarget).toHaveBeenCalledTimes(2)
    logSpy.mockRestore()
  })

  it('surfaces the resolution error when the daemon still is not up', async () => {
    await expect(openWebapp({
      ensureDaemon: () => Promise.resolve(),
      resolveTarget: () => Promise.reject(new Error('yaac daemon is not running. Start it with: yaac daemon start')),
    })).rejects.toThrow(/not running/)
  })
})
