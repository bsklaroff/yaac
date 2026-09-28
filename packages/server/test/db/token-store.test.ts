import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { loadTokens, saveTokens, type TokenEntry } from '#db'
import { getDb, closeDb } from '#db/client'
import { tokens as tokensTable } from '#db/schema'

// One PGlite per file: cold-init is the expensive part, so the DB-backed
// tests share a data dir and wipe the table instead of recreating it.
let tmpDir: string

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

describe('loadTokens', () => {
  it('returns [] when nothing has been persisted', async () => {
    expect(await loadTokens()).toEqual([])
  })

  it('reads back entries of every kind, including expiresAt', async () => {
    const now = new Date().toISOString()
    const entries: TokenEntry[] = [
      { name: 'laptop', token: 'b'.repeat(64), kind: 'durable', createdAt: now },
      { name: 'open-01234567', token: 'c'.repeat(64), kind: 'one-time', createdAt: now, expiresAt: now },
      { name: 'web-01234567', token: 'd'.repeat(64), kind: 'web', createdAt: now },
    ]
    await saveTokens(entries)
    expect(await loadTokens()).toEqual(entries)
  })

  it('orders by (createdAt, name)', async () => {
    await saveTokens([
      { name: 'z-late', token: 't1', kind: 'durable', createdAt: '2026-02-01T00:00:00.000Z' },
      { name: 'b-tie', token: 't2', kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z' },
      { name: 'a-tie', token: 't3', kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect((await loadTokens()).map((e) => e.name)).toEqual(['a-tie', 'b-tie', 'z-late'])
  })
})

describe('saveTokens', () => {
  it('replaces the previous set wholesale', async () => {
    const now = new Date().toISOString()
    await saveTokens([{ name: 'first', token: 't1', kind: 'durable', createdAt: now }])
    await saveTokens([{ name: 'second', token: 't2', kind: 'durable', createdAt: now }])
    expect((await loadTokens()).map((e) => e.name)).toEqual(['second'])
  })

  it('clears the table when the live store is empty', async () => {
    const now = new Date().toISOString()
    await saveTokens([{ name: 'only', token: 't1', kind: 'durable', createdAt: now }])
    await saveTokens([])
    expect(await loadTokens()).toEqual([])
  })
})
