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
import { readInstallRecord } from '#install-record'
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
    await fs.mkdir(clientLocalRoot(), { recursive: true })
    await fs.writeFile(serverConfigPath(), JSON.stringify({
      url: 'https://a.ts.net', token: 'ta', enabled: true,
      saved: [{ url: 'https://a.ts.net', token: 'ta' }],
    }))
    const cfg = await readServerConfig()
    expect(cfg).toEqual({ url: 'https://a.ts.net', enabled: true, saved: [{ url: 'https://a.ts.net' }] })
    await writeServerConfig(cfg!)
    expect(await fs.readFile(serverConfigPath(), 'utf8')).not.toContain('token')
  })

  it('lifts a legacy install record into install.json, and keeps a copy here for an older yaac', async () => {
    // An older `yaac` reads the record only from server.json: losing
    // `driver` here would let it start a host server on a k8s data dir.
    for (const rewrite of [
      async () => writeServerConfig(withServerSelected(await readServerConfig(), 'https://b.ts.net')),
      clearServerConfig,
    ]) {
      await fs.rm(path.join(dir, 'install.json'), { force: true })
      await fs.mkdir(clientLocalRoot(), { recursive: true })
      await fs.writeFile(serverConfigPath(), JSON.stringify({
        url: 'https://a.ts.net', enabled: true, saved: [], driver: 'k8s', installId: 'i-1',
      }))
      await rewrite()
      expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1' })
      expect(JSON.parse(await fs.readFile(serverConfigPath(), 'utf8'))).toMatchObject({ driver: 'k8s', installId: 'i-1' })
    }
    // Forgetting keeps the file while it carries the record.
    expect(await readServerConfig()).toEqual({ url: '', enabled: false, saved: [] })
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

  it('selects the origin and records the driver, keeping the other saved servers and the install record', async () => {
    await writeServerConfig({ url: 'https://srv.ts.net', enabled: false, saved: [] })
    await fs.writeFile(path.join(dir, 'install.json'), JSON.stringify({ driver: 'containerless', installId: 'i-1' }))
    await registerServer('http://127.0.0.1:8787', 'k8s')
    expect(await readServerConfig()).toEqual({
      url: 'http://127.0.0.1:8787',
      enabled: true,
      saved: [{ url: 'http://127.0.0.1:8787' }, { url: 'https://srv.ts.net' }],
    })
    expect(await readInstallRecord()).toEqual({ driver: 'k8s', installId: 'i-1', origin: 'http://127.0.0.1:8787' })
  })

  it('on a restart or re-install, leaves a selection of another server alone unless the origin is new', async () => {
    const host = 'http://127.0.0.1:8787'
    const cluster = 'http://127.0.0.1:8790'
    await writeServerConfig({ url: host, enabled: true, saved: [{ url: host }, { url: cluster }] })
    await registerServer(cluster, 'k8s', { keepSelection: true })
    expect(await readServerConfig()).toMatchObject({ url: host, enabled: true })
    // A first install's origin is new, so it is selected.
    await registerServer('https://srv.ts.net', 'k8s', { keepSelection: true })
    expect(await readServerConfig()).toMatchObject({ url: 'https://srv.ts.net' })
    // With nothing selected, a restart selects its server.
    await writeServerConfig({ url: host, enabled: false, saved: [{ url: host }, { url: cluster }] })
    await registerServer(cluster, 'k8s', { keepSelection: true })
    expect(await readServerConfig()).toMatchObject({ url: cluster, enabled: true })
    // A start always selects.
    await registerServer(host, 'containerless')
    expect(await readServerConfig()).toMatchObject({ url: host, enabled: true })
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
  afterEach(() => vi.unstubAllGlobals())

  it('checks /health then /whoami, and returns the build id and who this device is', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'b1' }))
      .mockResolvedValueOnce(Response.json({ kind: 'tailnet', login: 'bob@x', name: 'Bob' }))
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({}, { status: 500 })))
    await expect(probeServer('https://srv.ts.net')).rejects.toThrow(/HTTP 500/)
  })

  it('names a refused identity, in the server\'s words', async () => {
    // A tagged device through tailscale serve: the fix is on the tailnet,
    // and the server's message says so.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, buildId: 'b' }))
      .mockResolvedValueOnce(Response.json({
        error: { code: 'UNAUTHENTICATED', message: 'a tagged device, or Funnel' },
      }, { status: 401 })))
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
