import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  clearServerConfig,
  IdentityRejectedError,
  normalizeServerUrl,
  probeServer,
  readServerConfig,
  registerServer,
  serverConfigPath,
  withServerSelected,
  writeServerConfig,
} from '#server-config'
import { recordedDriver } from '#install-driver'
import { clientLocalRoot, setDataDir } from '#paths'

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
      enabled: true,
      saved: [{ url: 'https://srv.ts.net' }],
    }
    await writeServerConfig(cfg)
    expect(await readServerConfig()).toEqual(cfg)
    const stat = await fs.stat(serverConfigPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null when absent, cleared, or malformed', async () => {
    expect(await readServerConfig()).toBeNull()

    await writeServerConfig({ url: 'https://x', enabled: false, saved: [] })
    await clearServerConfig()
    expect(await readServerConfig()).toBeNull()
    await clearServerConfig() // idempotent

    await fs.writeFile(serverConfigPath(), 'not json')
    expect(await readServerConfig()).toBeNull()
    await fs.writeFile(serverConfigPath(), JSON.stringify({ url: 'x' }))
    expect(await readServerConfig()).toBeNull()
  })

  it('folds the active remote into saved and drops malformed saved entries', async () => {
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(serverConfigPath(), JSON.stringify({ url: 'https://old.ts.net', enabled: true }))
    expect((await readServerConfig())?.saved).toEqual([{ url: 'https://old.ts.net' }])

    await fs.writeFile(serverConfigPath(), JSON.stringify({
      url: 'https://a.ts.net',
      enabled: false,
      saved: [{ url: 'https://b.ts.net' }, { host: 'c' }, 'junk'],
    }))
    expect((await readServerConfig())?.saved).toEqual([
      { url: 'https://a.ts.net' },
      { url: 'https://b.ts.net' },
    ])
  })

  it('reads a file that still carries tokens, and the next write drops them', async () => {
    // What every install wrote before identity replaced tokens: nothing
    // needs converting, the field is simply no longer read.
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(serverConfigPath(), JSON.stringify({
      url: 'https://a.ts.net', token: 'ta', enabled: true,
      saved: [{ url: 'https://a.ts.net', token: 'ta' }], driver: 'k8s',
    }))
    const cfg = await readServerConfig()
    expect(cfg).toEqual({ url: 'https://a.ts.net', enabled: true, saved: [{ url: 'https://a.ts.net' }], driver: 'k8s' })
    await writeServerConfig(cfg!)
    expect(await fs.readFile(serverConfigPath(), 'utf8')).not.toContain('token')
  })

  it('keeps the install driver when the servers are forgotten', async () => {
    // `driver` shares this file, and losing it would stop a k8s install
    // refusing a host `yaac server start` — two writers on one data dir.
    await writeServerConfig({
      url: 'https://a.ts.net', enabled: true, saved: [], driver: 'k8s',
    })
    await clearServerConfig()
    expect(await readServerConfig()).toMatchObject({ driver: 'k8s', enabled: false, saved: [] })
    expect(await recordedDriver()).toBe('k8s')
    // With nothing selected, the empty url is not offered as a server.
    expect((await readServerConfig())?.saved).toEqual([])
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
      url: 'http://127.0.0.1:8787', enabled: true, saved: [],
      driver: 'containerless',
    })
    expect(await recordedDriver()).toBe('containerless')
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

  it('selects the origin and records the driver, keeping the other saved servers', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: false, saved: [], driver: 'containerless' })
    await registerServer('http://127.0.0.1:8787', 'k8s')
    expect(await readServerConfig()).toEqual({
      url: 'http://127.0.0.1:8787',
      enabled: true,
      saved: [{ url: 'http://127.0.0.1:8787' }, { url: 'https://srv.ts.net' }],
      driver: 'k8s',
    })
  })
})

describe('withServerSelected', () => {
  it('starts a fresh config from null', () => {
    expect(withServerSelected(null, 'https://a.ts.net')).toEqual({
      url: 'https://a.ts.net',
      enabled: true,
      saved: [{ url: 'https://a.ts.net' }],
    })
  })

  it('keeps other saved remotes and moves a re-set one to the front', () => {
    const existing = {
      url: 'https://a.ts.net',
      enabled: false,
      saved: [{ url: 'https://a.ts.net' }, { url: 'https://b.ts.net' }],
    }
    expect(withServerSelected(existing, 'https://b.ts.net')).toEqual({
      url: 'https://b.ts.net',
      enabled: true,
      saved: [{ url: 'https://b.ts.net' }, { url: 'https://a.ts.net' }],
    })
  })
})

describe('probeServer', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  afterEach(() => vi.unstubAllGlobals())

  it('checks /health then /whoami, and returns the build id and who this device is', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'b1' }))
      .mockResolvedValueOnce(jsonResponse({ kind: 'tailnet', login: 'bob@x', name: 'Bob' }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await probeServer('https://srv.ts.net')).toEqual({
      buildId: 'b1', principal: { kind: 'tailnet', login: 'bob@x', name: 'Bob' },
    })
    expect(fetchMock.mock.calls.map(([u]) => u as string))
      .toEqual(['https://srv.ts.net/api/health', 'https://srv.ts.net/api/whoami'])
  })

  it('throws prescriptively on unreachable or unhealthy servers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const unreachable = await probeServer('https://down.ts.net').catch((e: unknown) => e)
    expect(String(unreachable)).toMatch(/cannot reach/)
    expect(unreachable).not.toBeInstanceOf(IdentityRejectedError)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, 500)))
    await expect(probeServer('https://srv.ts.net')).rejects.toThrow(/HTTP 500/)
  })

  it('names a refused identity, in the server\'s words', async () => {
    // A tagged device reaching a server through tailscale serve: the fix is
    // on the tailnet, and the server's message is what says so.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, buildId: 'b' }))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: 'UNAUTHENTICATED', message: 'a tagged device, or Funnel' },
      }, 401)))
    const err = await probeServer('https://srv.ts.net').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IdentityRejectedError)
    expect(String(err)).toMatch(/refused to identify this device: a tagged device, or Funnel/)
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
