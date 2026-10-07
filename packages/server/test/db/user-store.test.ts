import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { accessModes, users } from '#db/schema'
import {
  BUILT_IN_USER_ID,
  listUsers,
  readAccessMode,
  recordAccessMode,
  seeTailnetUser,
} from '#db'
import { ne } from 'drizzle-orm'

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
  await db.delete(accessModes)
  await db.delete(users).where(ne(users.id, BUILT_IN_USER_ID))
  await db.update(users).set({ login: null, name: 'local' })
  // The seen-user cache is per process; a fresh handle starts it empty.
  await closeDb()
})

describe('seeTailnetUser', () => {
  it('creates a user on first sight and returns the same id after', async () => {
    const alice = await seeTailnetUser('alice@example.com', 'Alice')
    expect(alice).not.toBe(BUILT_IN_USER_ID)
    expect(await seeTailnetUser('alice@example.com', 'Alice')).toBe(alice)
    expect(await seeTailnetUser('bob@example.com', 'Bob')).not.toBe(alice)
  })

  it('writes a changed display name, but not a repeat sighting', async () => {
    const id = await seeTailnetUser('alice@example.com', 'Alice')
    const db = await getDb()
    // A repeat within the hour is served from the cache, so a row edited
    // underneath it stays edited.
    await db.update(users).set({ name: 'edited' })
    await seeTailnetUser('alice@example.com', 'Alice')
    expect((await listUsers()).find((u) => u.id === id)?.name).toBe('edited')
    await seeTailnetUser('alice@example.com', 'Alice Liddell')
    expect((await listUsers()).find((u) => u.id === id)?.name).toBe('Alice Liddell')
  })
})

describe('listUsers', () => {
  it('lists the built-in user first, then users in the order first seen', async () => {
    await seeTailnetUser('alice@example.com', 'Alice')
    await seeTailnetUser('bob@example.com', 'Bob')
    expect((await listUsers()).map((u) => u.login)).toEqual([null, 'alice@example.com', 'bob@example.com'])
  })
})

describe('readAccessMode', () => {
  it('is undefined for a fresh install', async () => {
    expect(await readAccessMode()).toBeUndefined()
  })
})

describe('recordAccessMode', () => {
  it('replaces the recorded mode, and with an owner gives the built-in user that login', async () => {
    await recordAccessMode('local')
    expect(await readAccessMode()).toBe('local')
    await recordAccessMode('tailnet', 'alice@example.com')
    expect(await readAccessMode()).toBe('tailnet')
    expect(await listUsers()).toEqual([{ id: BUILT_IN_USER_ID, login: 'alice@example.com', name: 'alice@example.com' }])
    // The login now identifies the built-in user, so everything it owns.
    expect(await seeTailnetUser('alice@example.com', 'Alice')).toBe(BUILT_IN_USER_ID)
  })
})
