import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { remoteSet, remoteUnset, remoteOn, remoteOff, remoteStatus } from '#commands/remote'
import { readRemote, writeRemote } from '@yaac/shared/remote'
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

  describe('remoteSet', () => {
    it('verifies health + token, then persists an enabled remote', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(jsonResponse({ tokens: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await remoteSet('https://srv.ts.net/', { token: 'tok' })

      expect(fetchMock.mock.calls[0][0]).toBe('https://srv.ts.net/health')
      const tokenCall = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(tokenCall[0]).toBe('https://srv.ts.net/tokens')
      expect(new Headers(tokenCall[1].headers).get('authorization')).toBe('Bearer tok')
      expect(await readRemote()).toEqual({
        url: 'https://srv.ts.net',
        token: 'tok',
        enabled: true,
        saved: [{ url: 'https://srv.ts.net', token: 'tok' }],
      })
      expect(errorSpy).not.toHaveBeenCalled() // no skew warning
    })

    it('keeps previously set remotes in the saved list', async () => {
      await writeRemote({
        url: 'https://old.ts.net',
        token: 'old-tok',
        enabled: true,
        saved: [{ url: 'https://old.ts.net', token: 'old-tok' }],
      })
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(jsonResponse({ tokens: [] })))

      await remoteSet('https://new.ts.net', { token: 'new-tok' })

      expect(await readRemote()).toEqual({
        url: 'https://new.ts.net',
        token: 'new-tok',
        enabled: true,
        saved: [
          { url: 'https://new.ts.net', token: 'new-tok' },
          { url: 'https://old.ts.net', token: 'old-tok' },
        ],
      })
    })

    it('warns (but succeeds) on build skew', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'server-build' }))
        .mockResolvedValueOnce(jsonResponse({ tokens: [] })))

      await remoteSet('https://srv.ts.net', { token: 'tok' })

      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/differs from this CLI/))
      expect((await readRemote())?.enabled).toBe(true)
    })

    it('fails without persisting when the server is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      await expect(remoteSet('https://down.ts.net', { token: 'tok' }))
        .rejects.toThrow(/cannot reach https:\/\/down\.ts\.net/)
      expect(await readRemote()).toBeNull()
    })

    it('fails without persisting when the token is rejected', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'cli-build' }))
        .mockResolvedValueOnce(jsonResponse({ error: { code: 'BAD_BEARER', message: 'x' } }, 401)))
      await expect(remoteSet('https://srv.ts.net', { token: 'bad' }))
        .rejects.toThrow(/token rejected.*yaac auth token create/s)
      expect(await readRemote()).toBeNull()
    })

    it('rejects a non-origin URL before any network call', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(remoteSet('https://srv.ts.net/path', { token: 't' }))
        .rejects.toThrow(/bare origin/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('remoteOff / remoteOn toggle without losing the token', async () => {
    const saved = [{ url: 'https://srv.ts.net', token: 'tok' }]
    await writeRemote({ url: 'https://srv.ts.net', token: 'tok', enabled: true, saved })
    await remoteOff()
    expect(await readRemote()).toEqual({ url: 'https://srv.ts.net', token: 'tok', enabled: false, saved })
    await remoteOn()
    expect(await readRemote()).toEqual({ url: 'https://srv.ts.net', token: 'tok', enabled: true, saved })
  })

  it('remoteOn / remoteOff without a configured remote throw guidance', async () => {
    await expect(remoteOn()).rejects.toThrow(/yaac remote set/)
    await expect(remoteOff()).rejects.toThrow(/yaac remote set/)
  })

  it('remoteUnset clears the config', async () => {
    await writeRemote({ url: 'https://srv.ts.net', token: 'tok', enabled: true, saved: [] })
    await remoteUnset()
    expect(await readRemote()).toBeNull()
  })

  it('remoteStatus prints the masked token, never the full value', async () => {
    await writeRemote({ url: 'https://srv.ts.net', token: 'a'.repeat(64), enabled: true, saved: [] })
    await remoteStatus()
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('https://srv.ts.net')
    expect(printed).toContain(`${'a'.repeat(8)}…`)
    expect(printed).not.toContain('a'.repeat(64))
    expect(printed).toMatch(/enabled\s+yes/)
    expect(printed).not.toMatch(/^saved/m) // no other saved remotes → no line
  })

  it('remoteStatus lists other saved remotes without their tokens', async () => {
    await writeRemote({
      url: 'https://a.ts.net',
      token: 'tok-a',
      enabled: true,
      saved: [
        { url: 'https://a.ts.net', token: 'tok-a' },
        { url: 'https://b.ts.net', token: 'tok-b' },
      ],
    })
    await remoteStatus()
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toMatch(/saved\s+https:\/\/b\.ts\.net/)
    expect(printed).not.toContain('tok-b')
  })

  it('remoteStatus without a remote prints setup guidance', async () => {
    await remoteStatus()
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/yaac remote set/))
  })
})
