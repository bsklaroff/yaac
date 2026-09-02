import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  clearServerConfig,
  normalizeServerUrl,
  probeServer,
  readServerConfig,
  registerServer,
  TokenRejectedError,
  serverConfigPath,
  withServerSelected,
  writeServerConfig,
} from '#server-config'
import { recordedDriver } from '#install-driver'
import { clientLocalPath, clientLocalRoot, serverLocalPath, setDataDir } from '#paths'

describe('server config store', () => {
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
    await writeServerConfig(cfg)
    expect(await readServerConfig()).toEqual(cfg)
    const stat = await fs.stat(serverConfigPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null when absent, cleared, or malformed', async () => {
    expect(await readServerConfig()).toBeNull()

    await writeServerConfig({ url: 'https://x', token: 't', enabled: false, saved: [] })
    await clearServerConfig()
    expect(await readServerConfig()).toBeNull()
    await clearServerConfig() // idempotent

    await fs.writeFile(serverConfigPath(), 'not json')
    expect(await readServerConfig()).toBeNull()
    await fs.writeFile(serverConfigPath(), JSON.stringify({ url: 'x' }))
    expect(await readServerConfig()).toBeNull()
  })

  it('folds the active remote into saved and drops malformed saved entries', async () => {
    // A file written before `saved` existed.
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(serverConfigPath(), JSON.stringify({
      url: 'https://old.ts.net', token: 'tok', enabled: true,
    }))
    expect((await readServerConfig())?.saved).toEqual([{ url: 'https://old.ts.net', token: 'tok' }])

    await fs.writeFile(serverConfigPath(), JSON.stringify({
      url: 'https://a.ts.net',
      token: 'ta',
      enabled: false,
      saved: [{ url: 'https://b.ts.net', token: 'tb' }, { url: 'https://c.ts.net' }, 'junk'],
    }))
    expect((await readServerConfig())?.saved).toEqual([
      { url: 'https://a.ts.net', token: 'ta' },
      { url: 'https://b.ts.net', token: 'tb' },
    ])
  })

  it('reads both older locations of remote.json, and migrates them on write', async () => {
    // The file was `remote.json` before a server on this machine could be
    // named by it, and lived in the data dir itself before the client-local
    // tier existed. Losing either silently would leave every client unable
    // to reach a running server with no hint why — docs/legacy-compat-shims.md.
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(serverLocalPath('remote.json'), JSON.stringify({
      url: 'https://oldest.ts.net', token: 'tok', enabled: true,
    }))
    expect((await readServerConfig())?.url).toBe('https://oldest.ts.net')

    // The nearer legacy path outranks the data-dir one.
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(clientLocalPath('remote.json'), JSON.stringify({
      url: 'https://old.ts.net', token: 'tok', enabled: true,
    }))
    expect((await readServerConfig())?.url).toBe('https://old.ts.net')

    // The first write moves it, and takes both stale bearer tokens with it —
    // a live credential left behind would outlive `clearServerConfig`.
    await writeServerConfig({ url: 'https://new.ts.net', token: 't2', enabled: true, saved: [] })
    expect((await readServerConfig())?.url).toBe('https://new.ts.net')
    await expect(fs.access(serverLocalPath('remote.json'))).rejects.toThrow()
    await expect(fs.access(clientLocalPath('remote.json'))).rejects.toThrow()

    // And the new location wins outright while both exist.
    await fs.writeFile(clientLocalPath('remote.json'), JSON.stringify({
      url: 'https://stale.ts.net', token: 'x', enabled: true,
    }))
    expect((await readServerConfig())?.url).toBe('https://new.ts.net')
  })

  it('keeps the install driver when the servers are forgotten', async () => {
    // `driver` shares this file, and losing it would stop a k8s install
    // refusing a host `yaac server start` — two writers on one data dir.
    await writeServerConfig({
      url: 'https://a.ts.net', token: 't', enabled: true, saved: [], driver: 'k8s',
    })
    await clearServerConfig()
    expect(await readServerConfig()).toMatchObject({ driver: 'k8s', enabled: false, saved: [] })
    expect(await recordedDriver()).toBe('k8s')
    // With nothing selected, the empty url is not offered as a server.
    expect((await readServerConfig())?.saved).toEqual([])
  })
})

describe('probeServer rejection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('marks a 401 as a rejection, and everything else as an ordinary failure', async () => {
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ ok: true, buildId: 'b' }))
      .mockResolvedValueOnce(json({}, 401)))
    await expect(probeServer('https://srv.ts.net', 'bad')).rejects.toBeInstanceOf(TokenRejectedError)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const unreachable = await probeServer('https://srv.ts.net', 't').catch((e: unknown) => e)
    expect(unreachable).toBeInstanceOf(Error)
    expect(unreachable).not.toBeInstanceOf(TokenRejectedError)
  })
})

describe('recordedDriver', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-driver-'))
    setDataDir(dir)
  })

  afterEach(async () => {
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('is undefined until something stands a server up', async () => {
    expect(await recordedDriver()).toBeUndefined()
  })

  it('reads the field written beside the origin', async () => {
    await writeServerConfig({
      url: 'http://127.0.0.1:8787', token: 't', enabled: true, saved: [],
      driver: 'containerless',
    })
    expect(await recordedDriver()).toBe('containerless')
  })

  it('is folded into any config written without one, so the file retires itself', async () => {
    // Every writer, not just the two registrars: `yaac remote set` on an
    // install that predates the field must not leave a `server.json` that
    // outranks the standalone file while saying nothing about the install.
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(clientLocalPath('driver'), 'k8s\n')
    await writeServerConfig(withServerSelected(null, 'https://elsewhere.ts.net', 't'))
    expect(await readServerConfig()).toMatchObject({ driver: 'k8s' })
    expect(await recordedDriver()).toBe('k8s')
  })

  it('falls back to the standalone file at both its old paths', async () => {
    // An install that has not re-registered since the record moved into
    // server.json — docs/legacy-compat-shims.md.
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(serverLocalPath('driver'), 'k8s\n')
    expect(await recordedDriver()).toBe('k8s')

    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(clientLocalPath('driver'), 'containerless\n')
    expect(await recordedDriver()).toBe('containerless')

    // The field outranks both once it exists.
    await writeServerConfig({
      url: 'http://127.0.0.1:8787', token: 't', enabled: true, saved: [], driver: 'k8s',
    })
    expect(await recordedDriver()).toBe('k8s')
  })
})

describe('registerServer', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-register-'))
    setDataDir(dir)
  })

  afterEach(async () => {
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  const ORIGIN = 'http://127.0.0.1:8787'

  it('mints a durable token, selects the origin, and records the driver', async () => {
    const mint = vi.fn().mockResolvedValue('minted')
    await registerServer(ORIGIN, 'containerless', { mint, probe: vi.fn() })
    expect(mint).toHaveBeenCalledWith(ORIGIN)
    expect(await readServerConfig()).toMatchObject({
      url: ORIGIN, token: 'minted', enabled: true, driver: 'containerless',
    })
  })

  it('reuses a saved token that still authenticates, rather than rotating it', async () => {
    // A routine `yaac server start` must not invalidate the token every
    // other client on this machine is already holding.
    await writeServerConfig({
      url: ORIGIN, token: 'existing', enabled: false, saved: [{ url: ORIGIN, token: 'existing' }],
    })
    const mint = vi.fn().mockResolvedValue('fresh')
    const probe = vi.fn().mockResolvedValue({ buildId: 'b' })
    await registerServer(ORIGIN, 'containerless', { mint, probe })
    expect(probe).toHaveBeenCalledWith(ORIGIN, 'existing')
    expect(mint).not.toHaveBeenCalled()
    expect(await readServerConfig()).toMatchObject({ token: 'existing', enabled: true })
  })

  it('mints again only when the server REJECTED the saved token', async () => {
    await writeServerConfig({
      url: ORIGIN, token: 'stale', enabled: true, saved: [{ url: ORIGIN, token: 'stale' }],
    })
    const mint = vi.fn().mockResolvedValue('fresh')
    const probe = vi.fn().mockRejectedValue(new TokenRejectedError('token rejected'))
    await registerServer(ORIGIN, 'containerless', { mint, probe })
    expect(mint).toHaveBeenCalledOnce()
    expect(await readServerConfig()).toMatchObject({ token: 'fresh' })
  })

  it('keeps a token it could not VERIFY, rather than replacing a good one with nothing', async () => {
    // The dangerous case: an unreachable or slow server fails the probe,
    // then fails the mint too — and writing that empty result would delete
    // a credential still valid on the server, locking this machine out of
    // a credential-requiring install until some later command succeeds.
    await writeServerConfig({
      url: ORIGIN, token: 'good', enabled: false, saved: [{ url: ORIGIN, token: 'good' }],
    })
    const mint = vi.fn().mockResolvedValue('')
    const probe = vi.fn().mockRejectedValue(new Error(`cannot reach ${ORIGIN}: timeout`))
    const log = vi.fn()
    await registerServer(ORIGIN, 'containerless', { mint, probe, log, credentialRequired: true })

    expect(mint).not.toHaveBeenCalled()
    expect(await readServerConfig()).toMatchObject({
      url: ORIGIN, token: 'good', enabled: true, driver: 'containerless',
    })
    expect(String(log.mock.calls[0][0])).toMatch(/could not verify/)
  })

  it('treats a 5xx or unhealthy server as unverified, not as a rejection', async () => {
    await writeServerConfig({
      url: ORIGIN, token: 'good', enabled: true, saved: [{ url: ORIGIN, token: 'good' }],
    })
    const mint = vi.fn().mockResolvedValue('fresh')
    for (const err of [
      new Error(`${ORIGIN}/health returned HTTP 503`),
      new Error(`token check against ${ORIGIN} failed (HTTP 502)`),
    ]) {
      await registerServer(ORIGIN, 'containerless', {
        mint, probe: vi.fn().mockRejectedValue(err),
      })
      expect(await readServerConfig()).toMatchObject({ token: 'good' })
    }
    expect(mint).not.toHaveBeenCalled()
  })

  it('keeps other saved servers and re-registers the driver on a switch of substrate', async () => {
    await writeServerConfig({
      url: 'https://elsewhere.ts.net', token: 'te', enabled: true,
      saved: [{ url: 'https://elsewhere.ts.net', token: 'te' }],
    })
    await registerServer(ORIGIN, 'k8s', { mint: () => Promise.resolve('m'), probe: vi.fn() })
    const cfg = await readServerConfig()
    expect(cfg?.saved).toContainEqual({ url: 'https://elsewhere.ts.net', token: 'te' })
    expect(cfg).toMatchObject({ url: ORIGIN, driver: 'k8s' })
  })

  it('an empty token is written silently on a credential-optional install', async () => {
    // Nothing checks it there, and refusing to write would leave the
    // machine pointed at no server at all.
    const log = vi.fn()
    await registerServer(ORIGIN, 'containerless', {
      mint: () => Promise.resolve(''), probe: vi.fn(), log,
    })
    expect(log).not.toHaveBeenCalled()
    expect(await readServerConfig()).toMatchObject({ url: ORIGIN, token: '' })
  })

  it('an empty token on a credential-REQUIRING install is a named lockout', async () => {
    const log = vi.fn()
    await registerServer(ORIGIN, 'containerless', {
      mint: () => Promise.resolve(''), probe: vi.fn(), log, credentialRequired: true,
    })
    expect(String(log.mock.calls[0][0])).toMatch(/WARNING.*yaac auth token create/s)
  })
})

describe('withServerSelected', () => {
  it('starts a fresh config from null', () => {
    expect(withServerSelected(null, 'https://a.ts.net', 'ta')).toEqual({
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
    expect(withServerSelected(existing, 'https://b.ts.net', 'tb2')).toEqual({
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

describe('probeServer', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  afterEach(() => vi.unstubAllGlobals())

  it('checks /health then the token, and returns the build id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'b1' }))
      .mockResolvedValueOnce(jsonResponse({ tokens: [] }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeServer('https://srv.ts.net', 'tok')).toEqual({ buildId: 'b1' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://srv.ts.net/health')
    const tokenCall = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(tokenCall[0]).toBe('https://srv.ts.net/tokens')
    expect(new Headers(tokenCall[1].headers).get('authorization')).toBe('Bearer tok')
  })

  it('throws prescriptively on unreachable, unhealthy, or rejected-token servers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(probeServer('https://down.ts.net', 't')).rejects.toThrow(/cannot reach/)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, 500)))
    await expect(probeServer('https://srv.ts.net', 't')).rejects.toThrow(/HTTP 500/)

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'b' }))
      .mockResolvedValueOnce(jsonResponse({}, 401)))
    await expect(probeServer('https://srv.ts.net', 'bad'))
      .rejects.toThrow(/token rejected.*yaac auth token create/s)
  })
})

describe('normalizeServerUrl', () => {
  it('canonicalizes to a bare origin', () => {
    expect(normalizeServerUrl('https://srv.ts.net/')).toBe('https://srv.ts.net')
    expect(normalizeServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeServerUrl('HTTPS://SRV.TS.NET')).toBe('https://srv.ts.net')
  })

  it('rejects non-http(s) schemes, paths, queries, and garbage', () => {
    expect(() => normalizeServerUrl('ftp://srv')).toThrow(/http\(s\)/)
    expect(() => normalizeServerUrl('https://srv.ts.net/api')).toThrow(/bare origin/)
    expect(() => normalizeServerUrl('https://srv.ts.net/?x=1')).toThrow(/bare origin/)
    expect(() => normalizeServerUrl('not a url')).toThrow(/invalid server URL/)
  })
})
