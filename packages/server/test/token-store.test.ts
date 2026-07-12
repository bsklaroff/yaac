import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createTokenStore,
  EXCHANGE_TTL_MS,
  loadTokens,
  MAX_EXCHANGE_TOKENS,
  MAX_WEB_SESSIONS,
  saveTokens,
  type TokenEntry,
} from '#token-store'
import { maskToken } from '@yaac/shared/mask'
import { ServerError } from '@yaac/shared/errors'
import { setDataDir, tokensPath } from '@yaac/shared/paths'

describe('createTokenStore', () => {
  it('mints a durable 64-hex token with an ISO createdAt', () => {
    const store = createTokenStore()
    const entry = store.create('laptop')
    expect(entry.name).toBe('laptop')
    expect(entry.kind).toBe('durable')
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

  it('lists masked summaries with kinds, never the full token', () => {
    const store = createTokenStore()
    const entry = store.create('laptop')
    const [summary] = store.list()
    expect(summary.name).toBe('laptop')
    expect(summary.kind).toBe('durable')
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
    const seed: TokenEntry = {
      name: 'old', token: 'a'.repeat(64), kind: 'durable', createdAt: new Date().toISOString(),
    }
    const snapshots: TokenEntry[][] = []
    const store = createTokenStore({ initialTokens: [seed], onChanged: (t) => snapshots.push(t) })
    expect(store.isValidToken(seed.token)).toBe(true)
    store.create('new')
    expect(snapshots.at(-1)).toHaveLength(2)
    store.revoke('old')
    expect(snapshots.at(-1)?.map((e) => e.name)).toEqual(['new'])
  })
})

describe('mintExchangeToken / consumeExchange', () => {
  it('mints an auto-named one-time token that expires after the TTL', () => {
    const store = createTokenStore({ now: () => 1000 })
    const entry = store.mintExchangeToken()
    expect(entry.kind).toBe('one-time')
    expect(entry.name).toMatch(/^open-[0-9a-f]{8}$/)
    expect(entry.token).toMatch(/^[0-9a-f]{64}$/)
    expect(Date.parse(entry.expiresAt as string)).toBe(1000 + EXCHANGE_TTL_MS)
  })

  it('exchanges a one-time token exactly once and mints a web session', () => {
    const store = createTokenStore()
    const entry = store.mintExchangeToken()
    const sid = store.consumeExchange(entry.token)
    expect(sid).toMatch(/^[0-9a-f]{64}$/)
    expect(store.isValidSession(sid as string)).toBe(true)
    // Consumed: the one-time entry is gone, so a replay fails.
    expect(store.consumeExchange(entry.token)).toBeNull()
    expect(store.list().filter((e) => e.kind === 'one-time')).toHaveLength(0)
  })

  it('exchanges a durable token without consuming it', () => {
    const store = createTokenStore()
    const entry = store.create('laptop')
    const a = store.consumeExchange(entry.token)
    const b = store.consumeExchange(entry.token)
    expect(a).not.toBe(b)
    expect(store.isValidSession(a as string)).toBe(true)
    expect(store.isValidSession(b as string)).toBe(true)
    expect(store.isValidToken(entry.token)).toBe(true)
  })

  it('rejects garbage and expired one-time tokens', () => {
    let t = 0
    const store = createTokenStore({ now: () => t })
    expect(store.consumeExchange('not-a-token')).toBeNull()

    const entry = store.mintExchangeToken()
    t = EXCHANGE_TTL_MS + 1
    expect(store.consumeExchange(entry.token)).toBeNull()
    // The expired entry was pruned, not just skipped.
    expect(store.list().filter((e) => e.kind === 'one-time')).toHaveLength(0)
  })

  it('accepts an unexpired one-time token right up to the TTL', () => {
    let t = 0
    const store = createTokenStore({ now: () => t })
    const entry = store.mintExchangeToken()
    t = EXCHANGE_TTL_MS - 1
    expect(store.consumeExchange(entry.token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never accepts one-time or web tokens as bearers, or non-web as sessions', () => {
    const store = createTokenStore()
    const oneTime = store.mintExchangeToken()
    const sid = store.consumeExchange(store.mintExchangeToken().token) as string
    const durable = store.create('laptop')
    expect(store.isValidToken(oneTime.token)).toBe(false)
    expect(store.isValidToken(sid)).toBe(false)
    expect(store.isValidSession(durable.token)).toBe(false)
    expect(store.isValidSession(oneTime.token)).toBe(false)
  })

  it('caps web sessions, evicting the oldest, and never evicts durable tokens', () => {
    const store = createTokenStore()
    const durable = store.create('laptop')
    const sids: string[] = []
    for (let i = 0; i < MAX_WEB_SESSIONS + 5; i++) {
      sids.push(store.consumeExchange(durable.token) as string)
    }
    expect(store.list().filter((e) => e.kind === 'web')).toHaveLength(MAX_WEB_SESSIONS)
    expect(store.isValidSession(sids[0])).toBe(false) // oldest evicted
    expect(store.isValidSession(sids[sids.length - 1])).toBe(true) // newest kept
    expect(store.isValidToken(durable.token)).toBe(true)
  })

  it('caps pending one-time tokens, evicting the oldest', () => {
    const store = createTokenStore()
    const first = store.mintExchangeToken()
    for (let i = 0; i < MAX_EXCHANGE_TOKENS; i++) store.mintExchangeToken()
    expect(store.list().filter((e) => e.kind === 'one-time')).toHaveLength(MAX_EXCHANGE_TOKENS)
    expect(store.consumeExchange(first.token)).toBeNull()
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

  it('round-trips entries of every kind at mode 0600', async () => {
    const now = new Date().toISOString()
    const entries: TokenEntry[] = [
      { name: 'laptop', token: 'b'.repeat(64), kind: 'durable', createdAt: now },
      { name: 'open-01234567', token: 'c'.repeat(64), kind: 'one-time', createdAt: now, expiresAt: now },
      { name: 'web-01234567', token: 'd'.repeat(64), kind: 'web', createdAt: now },
    ]
    await saveTokens(entries)
    const stat = await fs.stat(tokensPath())
    expect(stat.mode & 0o777).toBe(0o600)
    expect(await loadTokens()).toEqual(entries)
  })

  it('returns [] for a missing file', async () => {
    expect(await loadTokens()).toEqual([])
  })

  it('defaults pre-kind entries to durable (old tokens.json files)', async () => {
    await fs.writeFile(tokensPath(), JSON.stringify([{ name: 'old', token: 't', createdAt: 'c' }]))
    expect(await loadTokens()).toEqual([{ name: 'old', token: 't', createdAt: 'c', kind: 'durable' }])
  })

  it('returns [] for garbage and drops malformed entries', async () => {
    await fs.writeFile(tokensPath(), 'not json')
    expect(await loadTokens()).toEqual([])
    await fs.writeFile(tokensPath(), JSON.stringify([{ name: 'ok', token: 't', createdAt: 'c' }, { nope: 1 }, 'str']))
    expect(await loadTokens()).toEqual([{ name: 'ok', token: 't', createdAt: 'c', kind: 'durable' }])
  })
})
