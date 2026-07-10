import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createTokenStore,
  loadTokens,
  saveTokens,
  type TokenEntry,
} from '@yaac/server/token-store'
import { maskToken } from '@yaac/shared/mask'
import { ServerError } from '@yaac/shared/errors'
import { setDataDir, tokensPath } from '@yaac/shared/paths'

describe('createTokenStore', () => {
  it('mints a 64-hex token with an ISO createdAt', () => {
    const store = createTokenStore()
    const entry = store.create('laptop')
    expect(entry.name).toBe('laptop')
    expect(entry.token).toMatch(/^[0-9a-f]{64}$/)
    expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt)
  })

  it('rejects an invalid name with VALIDATION', () => {
    const store = createTokenStore()
    for (const bad of ['', 'has space', '-leading', 'a'.repeat(65), 'sla/sh']) {
      try {
        store.create(bad)
        expect.unreachable(`accepted invalid name ${JSON.stringify(bad)}`)
      } catch (err) {
        expect(err).toBeInstanceOf(ServerError)
        expect((err as ServerError).code).toBe('VALIDATION')
      }
    }
  })

  it('rejects a duplicate name with CONFLICT', () => {
    const store = createTokenStore()
    store.create('laptop')
    try {
      store.create('laptop')
      expect.unreachable('accepted duplicate name')
    } catch (err) {
      expect((err as ServerError).code).toBe('CONFLICT')
    }
  })

  it('lists masked summaries, never the full token', () => {
    const store = createTokenStore()
    const entry = store.create('laptop')
    const [summary] = store.list()
    expect(summary.name).toBe('laptop')
    expect(summary.masked).toBe(maskToken(entry.token))
    expect(JSON.stringify(store.list())).not.toContain(entry.token)
  })

  it('validates minted tokens and rejects revoked or unknown ones', () => {
    const store = createTokenStore()
    const entry = store.create('laptop')
    expect(store.isValidToken(entry.token)).toBe(true)
    expect(store.isValidToken('f'.repeat(64))).toBe(false)
    expect(store.revoke('laptop')).toBe(true)
    expect(store.isValidToken(entry.token)).toBe(false)
  })

  it('revoke returns false for an unknown name', () => {
    expect(createTokenStore().revoke('ghost')).toBe(false)
  })

  it('seeds from initialTokens and reports changes', () => {
    const seed: TokenEntry = { name: 'old', token: 'a'.repeat(64), createdAt: new Date().toISOString() }
    const snapshots: TokenEntry[][] = []
    const store = createTokenStore({ initialTokens: [seed], onChanged: (t) => snapshots.push(t) })
    expect(store.isValidToken(seed.token)).toBe(true)
    store.create('new')
    expect(snapshots.at(-1)).toHaveLength(2)
    store.revoke('old')
    expect(snapshots.at(-1)?.map((e) => e.name)).toEqual(['new'])
  })
})

describe('maskToken', () => {
  it('keeps only an 8-char prefix', () => {
    expect(maskToken('abcdef0123456789')).toBe('abcdef01…')
  })
})

describe('loadTokens / saveTokens', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tokens-'))
    setDataDir(dir)
  })

  afterEach(async () => {
    setDataDir('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trips entries at mode 0600', async () => {
    const entries: TokenEntry[] = [
      { name: 'laptop', token: 'b'.repeat(64), createdAt: new Date().toISOString() },
    ]
    await saveTokens(entries)
    const stat = await fs.stat(tokensPath())
    expect(stat.mode & 0o777).toBe(0o600)
    expect(await loadTokens()).toEqual(entries)
  })

  it('returns [] for a missing file', async () => {
    expect(await loadTokens()).toEqual([])
  })

  it('returns [] for garbage and drops malformed entries', async () => {
    await fs.writeFile(tokensPath(), 'not json')
    expect(await loadTokens()).toEqual([])
    await fs.writeFile(tokensPath(), JSON.stringify([{ name: 'ok', token: 't', createdAt: 'c' }, { nope: 1 }, 'str']))
    expect(await loadTokens()).toEqual([{ name: 'ok', token: 't', createdAt: 'c' }])
  })
})
