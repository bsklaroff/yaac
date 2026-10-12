import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { remoteAdd, remoteConnect, remoteDisconnect, remoteList, remoteRemove } from '#commands/remote'
import { readServerConfig, writeServerConfig } from '@yaac/shared/server-config'
import { setDataDir } from '@yaac/shared/paths'

describe('yaac remote commands', () => {
  let dir: string
  let logSpy: MockInstance<typeof console.log>
  let errorSpy: MockInstance<typeof console.error>

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-remote-cmd-'))
    setDataDir(dir)
    vi.stubEnv('YAAC_BUILD_ID', 'cli-build')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    logSpy.mockRestore()
    errorSpy.mockRestore()
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  const LOCAL = { kind: 'local' }

  describe('remoteAdd', () => {
    it('verifies health and identity, then saves and selects it, saying who it is', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(Response.json({ kind: 'tailnet', login: 'alice@example.com', name: 'Alice' }))
      vi.stubGlobal('fetch', fetchMock)

      await remoteAdd('https://srv.ts.net/')

      expect(fetchMock.mock.calls.map(([u]) => u as string))
        .toEqual(['https://srv.ts.net/api/health', 'https://srv.ts.net/api/whoami'])
      expect(await readServerConfig()).toEqual({
        url: 'https://srv.ts.net',
        saved: [{ url: 'https://srv.ts.net' }],
      })
      expect(logSpy).toHaveBeenCalledWith('Server selected: https://srv.ts.net (as alice@example.com)')
      expect(errorSpy).not.toHaveBeenCalled() // no skew warning
    })

    it('keeps previously set remotes in the saved list', async () => {
      await writeServerConfig({
        url: 'https://old.ts.net',
        saved: [{ url: 'https://old.ts.net' }],
      })
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(Response.json(LOCAL)))

      await remoteAdd('https://new.ts.net')

      expect(await readServerConfig()).toEqual({
        url: 'https://new.ts.net',
        saved: [{ url: 'https://new.ts.net' }, { url: 'https://old.ts.net' }],
      })
    })

    it('warns (but succeeds) on build skew', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'server-build' }))
        .mockResolvedValueOnce(Response.json(LOCAL)))

      await remoteAdd('https://srv.ts.net')

      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/differs from this CLI/))
      expect((await readServerConfig())?.url).toBe('https://srv.ts.net')
    })

    it('fails without persisting when the server is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      await expect(remoteAdd('https://down.ts.net'))
        .rejects.toThrow(/cannot reach https:\/\/down\.ts\.net/)
      expect(await readServerConfig()).toBeNull()
    })

    it('reports an unidentified device in the server\'s words, without persisting', async () => {
      // A tagged device (or Funnel) via tailscale serve: the server is up
      // but cannot identify the caller.
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(Response.json({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'tailscale serve sent no user identity: this device is a tagged device',
          },
        }, { status: 401 })))
      await expect(remoteAdd('https://srv.ts.net'))
        .rejects.toThrow(/refused to identify this device: tailscale serve sent no user identity.*tagged device/)
      expect(await readServerConfig()).toBeNull()
    })

    it('rejects a non-origin URL before any network call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(remoteAdd('https://srv.ts.net/path')).rejects.toThrow(/bare origin/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  /** Answer the next /health + /whoami probe as a reachable, local server. */
  function stubReachable(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'cli-build' }))
      .mockResolvedValueOnce(Response.json(LOCAL))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  describe('remoteConnect', () => {
    it('probes a saved server, then selects it, keeping the rest saved', async () => {
      const saved = [{ url: 'https://a.ts.net' }, { url: 'https://b.ts.net' }]
      await writeServerConfig({ url: '', saved })
      const fetchMock = stubReachable()

      await remoteConnect('https://b.ts.net/')

      expect(fetchMock).toHaveBeenCalledWith('https://b.ts.net/api/health', expect.anything())
      expect(await readServerConfig()).toEqual({
        url: 'https://b.ts.net',
        saved: [{ url: 'https://b.ts.net' }, { url: 'https://a.ts.net' }],
      })
      expect(logSpy).toHaveBeenCalledWith('Server selected: https://b.ts.net')
    })

    it('refuses a server that is not saved, pointing at add, without probing', async () => {
      await writeServerConfig({ url: 'https://a.ts.net', saved: [] })
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(remoteConnect('https://b.ts.net')).rejects.toThrow(/yaac remote add https:\/\/b\.ts\.net/)
      expect(fetchMock).not.toHaveBeenCalled()
      expect((await readServerConfig())?.url).toBe('https://a.ts.net')
    })

    it('leaves the selection alone when the saved server does not answer', async () => {
      await writeServerConfig({ url: '', saved: [{ url: 'https://a.ts.net' }] })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      await expect(remoteConnect('https://a.ts.net')).rejects.toThrow(/cannot reach/)
      expect((await readServerConfig())?.url).toBe('')
    })
  })

  describe('remoteDisconnect', () => {
    it('deselects without forgetting, and is a no-op with nothing configured', async () => {
      await remoteDisconnect()
      expect(await readServerConfig()).toBeNull()

      const saved = [{ url: 'https://a.ts.net' }]
      await writeServerConfig({ url: 'https://a.ts.net', saved })
      await remoteDisconnect()
      expect(await readServerConfig()).toEqual({ url: '', saved })
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac remote connect/))
    })
  })

  describe('remoteList', () => {
    it('marks the selected server, and says when none is', async () => {
      await writeServerConfig({ url: 'https://a.ts.net', saved: [{ url: 'https://a.ts.net' }, { url: 'https://b.ts.net' }] })
      await remoteList()
      expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])))
        .toEqual(['* https://a.ts.net', '  https://b.ts.net'])

      logSpy.mockClear()
      await remoteDisconnect()
      logSpy.mockClear()
      await remoteList()
      expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '  https://a.ts.net',
        '  https://b.ts.net',
        'No server selected. Pick one with: yaac remote connect <url>',
      ])
    })

    it('with nothing saved, prints setup guidance', async () => {
      await remoteList()
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac remote add <url>/))
    })
  })

  describe('remoteRemove', () => {
    it('forgets a saved server, refusing the selected one and an unknown one', async () => {
      const a = { url: 'https://a.ts.net' }
      const b = { url: 'https://b.ts.net' }
      await writeServerConfig({ url: a.url, saved: [a, b] })

      await expect(remoteRemove(a.url)).rejects.toThrow(/selected server.*yaac remote disconnect/)
      await expect(remoteRemove('https://c.ts.net')).rejects.toThrow(/Unknown server/)
      expect(await readServerConfig()).toEqual({ url: a.url, saved: [a, b] })

      await remoteRemove('https://b.ts.net/')
      expect(await readServerConfig()).toEqual({ url: a.url, saved: [a] })
      await remoteDisconnect()
      await remoteRemove(a.url)
      expect(await readServerConfig()).toEqual({ url: '', saved: [] })
    })
  })
})
