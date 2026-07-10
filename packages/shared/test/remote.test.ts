import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  clearRemote,
  normalizeRemoteUrl,
  readRemote,
  remoteConfigPath,
  writeRemote,
} from '#remote'
import { setDataDir } from '#paths'

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
    const cfg = { url: 'https://srv.ts.net', token: 't0k', enabled: true }
    await writeRemote(cfg)
    expect(await readRemote()).toEqual(cfg)
    const stat = await fs.stat(remoteConfigPath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null when absent, cleared, or malformed', async () => {
    expect(await readRemote()).toBeNull()

    await writeRemote({ url: 'https://x', token: 't', enabled: false })
    await clearRemote()
    expect(await readRemote()).toBeNull()
    await clearRemote() // idempotent

    await fs.writeFile(remoteConfigPath(), 'not json')
    expect(await readRemote()).toBeNull()
    await fs.writeFile(remoteConfigPath(), JSON.stringify({ url: 'x' }))
    expect(await readRemote()).toBeNull()
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
