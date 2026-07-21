import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  createTokenStore,
  EXCHANGE_TTL_MS,
  loadTokens,
  MAX_EXCHANGE_TOKENS,
  MAX_WEB_SESSIONS,
  saveTokens,
  type TokenEntry,
} from '#http/token-store'
import { getDb, closeDb } from '#platform/db/client'
import { tokens as tokensTable } from '#platform/db/schema'
import { maskToken } from '@yaac/shared/mask'
import { ServerError } from '@yaac/shared/errors'

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

  it('restoreTokens merges persisted entries, the in-memory one winning by name', () => {
    const store = createTokenStore()
    const live = store.create('laptop')
    const stale: TokenEntry = {
      name: 'laptop', token: 'e'.repeat(64), kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z',
    }
    const other: TokenEntry = {
      name: 'phone', token: 'f'.repeat(64), kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z',
    }
    store.restoreTokens([stale, other])
    expect(store.isValidToken(live.token)).toBe(true)
    expect(store.isValidToken(stale.token)).toBe(false)
    expect(store.isValidToken(other.token)).toBe(true)
    expect(store.list().map((e) => e.name).sort()).toEqual(['laptop', 'phone'])
  })

  it('restored entries count as oldest for the per-kind FIFO cap', () => {
    const store = createTokenStore()
    const durable = store.create('laptop')
    const restored: TokenEntry = {
      name: 'web-restored', token: 'a'.repeat(64), kind: 'web', createdAt: '2026-01-01T00:00:00.000Z',
    }
    store.restoreTokens([restored])
    let last = ''
    for (let i = 0; i < MAX_WEB_SESSIONS; i++) {
      last = store.consumeExchange(durable.token) as string
    }
    expect(store.isValidSession(restored.token)).toBe(false) // evicted first
    expect(store.isValidSession(last)).toBe(true)
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

describe('loadTokens / saveTokens (DB-backed)', () => {
  let tmpDir: string

  // One PGlite per file: cold-init is the expensive part, so the tests
  // share a data dir and wipe the table instead of recreating it.
  // (Pre-kind and malformed legacy tokens.json files are exercised in
  // db-legacy-import.test.ts — the DB rows always carry a kind.)
  beforeAll(async () => {
    tmpDir = await createTempDataDir()
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    const db = await getDb()
    await db.delete(tokensTable)
  })

  it('round-trips entries of every kind, including expiresAt', async () => {
    const now = new Date().toISOString()
    const entries: TokenEntry[] = [
      { name: 'laptop', token: 'b'.repeat(64), kind: 'durable', createdAt: now },
      { name: 'open-01234567', token: 'c'.repeat(64), kind: 'one-time', createdAt: now, expiresAt: now },
      { name: 'web-01234567', token: 'd'.repeat(64), kind: 'web', createdAt: now },
    ]
    await saveTokens(entries)
    expect(await loadTokens()).toEqual(entries)
  })

  it('returns [] when nothing has been persisted', async () => {
    expect(await loadTokens()).toEqual([])
  })

  it('orders by (createdAt, name)', async () => {
    await saveTokens([
      { name: 'z-late', token: 't1', kind: 'durable', createdAt: '2026-02-01T00:00:00.000Z' },
      { name: 'b-tie', token: 't2', kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z' },
      { name: 'a-tie', token: 't3', kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect((await loadTokens()).map((e) => e.name)).toEqual(['a-tie', 'b-tie', 'z-late'])
  })

  it('replaces the previous set wholesale', async () => {
    const now = new Date().toISOString()
    await saveTokens([{ name: 'first', token: 't1', kind: 'durable', createdAt: now }])
    await saveTokens([{ name: 'second', token: 't2', kind: 'durable', createdAt: now }])
    expect((await loadTokens()).map((e) => e.name)).toEqual(['second'])
  })
})
