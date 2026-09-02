import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  clearRemote,
  normalizeRemoteUrl,
  probeRemote,
  readRemote,
  remoteConfigPath,
  withRemoteActivated,
  writeRemote,
} from '#remote'
import { clientLocalRoot, serverLocalPath, setDataDir } from '#paths'

describe('remote config store', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-remote-'))
    setDataDir(dir)
  })

  afterEach(async () => {
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trips the config at mode 0600', async () => {
    const cfg = {
      url: 'https://srv.ts.net',
      token: 't0k',
      enabled: true,
      saved: [{ url: 'https://srv.ts.net', token: 't0k' }],
    }
    await writeRemote(cfg)
    expect(await readRemote()).toEqual(cfg)
    const stat = await fs.stat(remoteConfigPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null when absent, cleared, or malformed', async () => {
    expect(await readRemote()).toBeNull()

    await writeRemote({ url: 'https://x', token: 't', enabled: false, saved: [] })
    await clearRemote()
    expect(await readRemote()).toBeNull()
    await clearRemote() // idempotent

    await fs.writeFile(remoteConfigPath(), 'not json')
    expect(await readRemote()).toBeNull()
    await fs.writeFile(remoteConfigPath(), JSON.stringify({ url: 'x' }))
    expect(await readRemote()).toBeNull()
  })

  it('folds the active remote into saved and drops malformed saved entries', async () => {
    // A file written before `saved` existed.
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(remoteConfigPath(), JSON.stringify({
      url: 'https://old.ts.net', token: 'tok', enabled: true,
    }))
    expect((await readRemote())?.saved).toEqual([{ url: 'https://old.ts.net', token: 'tok' }])

    await fs.writeFile(remoteConfigPath(), JSON.stringify({
      url: 'https://a.ts.net',
      token: 'ta',
      enabled: false,
      saved: [{ url: 'https://b.ts.net', token: 'tb' }, { url: 'https://c.ts.net' }, 'junk'],
    }))
    expect((await readRemote())?.saved).toEqual([
      { url: 'https://a.ts.net', token: 'ta' },
      { url: 'https://b.ts.net', token: 'tb' },
    ])
  })

  it('reads a pre-split remote from the data dir, and migrates it on write', async () => {
    // Installs that predate the client-local tier wrote remote.json into
    // the data dir itself. Losing it silently would leave the CLI unable to
    // reach an in-cluster server with no hint as to why — see
    // docs/legacy-compat-shims.md.
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(serverLocalPath('remote.json'), JSON.stringify({
      url: 'https://old.ts.net', token: 'tok', enabled: true,
    }))
    expect((await readRemote())?.url).toBe('https://old.ts.net')

    // The first write moves it, and takes the stale bearer token with it —
    // a live credential left in the old place would outlive `clearRemote`.
    await writeRemote({ url: 'https://new.ts.net', token: 't2', enabled: true, saved: [] })
    expect((await readRemote())?.url).toBe('https://new.ts.net')
    await expect(fs.access(serverLocalPath('remote.json'))).rejects.toThrow()

    // And the new location wins outright while both exist.
    await fs.writeFile(serverLocalPath('remote.json'), JSON.stringify({
      url: 'https://stale.ts.net', token: 'x', enabled: true,
    }))
    expect((await readRemote())?.url).toBe('https://new.ts.net')
  })
})

describe('withRemoteActivated', () => {
  it('starts a fresh config from null', () => {
    expect(withRemoteActivated(null, 'https://a.ts.net', 'ta')).toEqual({
      url: 'https://a.ts.net',
      token: 'ta',
      enabled: true,
      saved: [{ url: 'https://a.ts.net', token: 'ta' }],
    })
  })

  it('keeps other saved remotes and replaces the token of a re-set one', () => {
    const existing = {
      url: 'https://a.ts.net',
      token: 'ta',
      enabled: false,
      saved: [
        { url: 'https://a.ts.net', token: 'ta' },
        { url: 'https://b.ts.net', token: 'tb' },
      ],
    }
    expect(withRemoteActivated(existing, 'https://b.ts.net', 'tb2')).toEqual({
      url: 'https://b.ts.net',
      token: 'tb2',
      enabled: true,
      saved: [
        { url: 'https://b.ts.net', token: 'tb2' },
        { url: 'https://a.ts.net', token: 'ta' },
      ],
    })
  })
})

describe('probeRemote', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  afterEach(() => vi.unstubAllGlobals())

  it('checks /health then the token, and returns the build id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'b1' }))
      .mockResolvedValueOnce(jsonResponse({ tokens: [] }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeRemote('https://srv.ts.net', 'tok')).toEqual({ buildId: 'b1' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://srv.ts.net/health')
    const tokenCall = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(tokenCall[0]).toBe('https://srv.ts.net/tokens')
    expect(new Headers(tokenCall[1].headers).get('authorization')).toBe('Bearer tok')
  })

  it('throws prescriptively on unreachable, unhealthy, or rejected-token servers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(probeRemote('https://down.ts.net', 't')).rejects.toThrow(/cannot reach/)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, 500)))
    await expect(probeRemote('https://srv.ts.net', 't')).rejects.toThrow(/HTTP 500/)

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'b' }))
      .mockResolvedValueOnce(jsonResponse({}, 401)))
    await expect(probeRemote('https://srv.ts.net', 'bad'))
      .rejects.toThrow(/token rejected.*yaac auth token create/s)
  })
})

describe('normalizeRemoteUrl', () => {
  it('canonicalizes to a bare origin', () => {
    expect(normalizeRemoteUrl('https://srv.ts.net/')).toBe('https://srv.ts.net')
    expect(normalizeRemoteUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeRemoteUrl('HTTPS://SRV.TS.NET')).toBe('https://srv.ts.net')
  })

  it('rejects non-http(s) schemes, paths, queries, and garbage', () => {
    expect(() => normalizeRemoteUrl('ftp://srv')).toThrow(/http\(s\)/)
    expect(() => normalizeRemoteUrl('https://srv.ts.net/api')).toThrow(/bare origin/)
    expect(() => normalizeRemoteUrl('https://srv.ts.net/?x=1')).toThrow(/bare origin/)
    expect(() => normalizeRemoteUrl('not a url')).toThrow(/invalid remote URL/)
  })
})
