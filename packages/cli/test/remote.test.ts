import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { remoteSet, remoteUnset, remoteOn, remoteOff, remoteStatus } from '#commands/remote'
import { readServerConfig, writeServerConfig } from '@yaac/shared/server-config'
import { setDataDir } from '@yaac/shared/paths'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

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

  describe('remoteSet', () => {
    it('verifies health and identity, then persists an enabled remote, saying who it is', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(jsonResponse({ kind: 'tailnet', login: 'alice@example.com', name: 'Alice' }))
      vi.stubGlobal('fetch', fetchMock)

      await remoteSet('https://srv.ts.net/')

      expect(fetchMock.mock.calls.map(([u]) => u as string))
        .toEqual(['https://srv.ts.net/health', 'https://srv.ts.net/whoami'])
      expect(await readServerConfig()).toEqual({
        url: 'https://srv.ts.net',
        enabled: true,
        saved: [{ url: 'https://srv.ts.net' }],
      })
      expect(logSpy).toHaveBeenCalledWith('Server selected: https://srv.ts.net (as alice@example.com)')
      expect(errorSpy).not.toHaveBeenCalled() // no skew warning
    })

    it('keeps previously set remotes in the saved list', async () => {
      await writeServerConfig({
        url: 'https://old.ts.net',
        enabled: true,
        saved: [{ url: 'https://old.ts.net' }],
      })
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(jsonResponse(LOCAL)))

      await remoteSet('https://new.ts.net')

      expect(await readServerConfig()).toEqual({
        url: 'https://new.ts.net',
        enabled: true,
        saved: [{ url: 'https://new.ts.net' }, { url: 'https://old.ts.net' }],
      })
    })

    it('warns (but succeeds) on build skew', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'server-build' }))
        .mockResolvedValueOnce(jsonResponse(LOCAL)))

      await remoteSet('https://srv.ts.net')

      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/differs from this CLI/))
      expect((await readServerConfig())?.enabled).toBe(true)
    })

    it('fails without persisting when the server is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      await expect(remoteSet('https://down.ts.net'))
        .rejects.toThrow(/cannot reach https:\/\/down\.ts\.net/)
      expect(await readServerConfig()).toBeNull()
    })

    it('reports an unidentified device in the server\'s words, without persisting', async () => {
      // A tagged device (or Funnel) reaching the server through tailscale
      // serve: the server is up, and will not say who this is.
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(jsonResponse({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'tailscale serve sent no user identity: this device is a tagged device',
          },
        }, 401)))
      await expect(remoteSet('https://srv.ts.net'))
        .rejects.toThrow(/refused to identify this device: tailscale serve sent no user identity.*tagged device/)
      expect(await readServerConfig()).toBeNull()
    })

    it('rejects a non-origin URL before any network call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(remoteSet('https://srv.ts.net/path')).rejects.toThrow(/bare origin/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('remoteOff / remoteOn toggle without losing the server', async () => {
    const saved = [{ url: 'https://srv.ts.net' }]
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: true, saved })
    await remoteOff()
    expect(await readServerConfig()).toEqual({ url: 'https://srv.ts.net', enabled: false, saved })
    await remoteOn()
    expect(await readServerConfig()).toEqual({ url: 'https://srv.ts.net', enabled: true, saved })
  })

  it('remoteOn / remoteOff without a configured remote throw guidance', async () => {
    await expect(remoteOn()).rejects.toThrow(/yaac remote set/)
    await expect(remoteOff()).rejects.toThrow(/yaac remote set/)
  })

  it('remoteUnset clears the config', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: true, saved: [] })
    await remoteUnset()
    expect(await readServerConfig()).toBeNull()
  })

  it('remoteStatus prints the selection, and other saved remotes when there are any', async () => {
    await writeServerConfig({ url: 'https://a.ts.net', enabled: true, saved: [] })
    await remoteStatus()
    let printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('https://a.ts.net')
    expect(printed).toMatch(/selected\s+yes/)
    expect(printed).not.toMatch(/^saved/m) // no other saved remotes → no line

    logSpy.mockClear()
    await writeServerConfig({
      url: 'https://a.ts.net',
      enabled: true,
      saved: [{ url: 'https://a.ts.net' }, { url: 'https://b.ts.net' }],
    })
    await remoteStatus()
    printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toMatch(/saved\s+https:\/\/b\.ts\.net/)
  })

  it('remoteStatus without a remote prints setup guidance', async () => {
    await remoteStatus()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac remote set/))
  })
})
