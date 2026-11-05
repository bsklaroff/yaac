import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { accessModes, users } from '#db/schema'
import {
  BUILT_IN_USER_ID,
  getUser,
  listAdmins,
  listUsers,
  readAccessMode,
  recordAccessMode,
  replaceAdmins,
  seeTailnetUser,
  setUserRole,
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
  await db.update(users).set({ login: null, name: 'local', role: 'admin' })
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

describe('getUser', () => {
  it('reads one user with its role, or undefined', async () => {
    const alice = await seeTailnetUser('alice@example.com', 'Alice')
    expect(await getUser(alice)).toEqual({ id: alice, login: 'alice@example.com', name: 'Alice', role: 'member' })
    expect(await getUser(BUILT_IN_USER_ID)).toMatchObject({ role: 'admin' })
    expect(await getUser('4101bef8-794f-4d98-8e95-dfb54850c68b')).toBeUndefined()
  })
})

describe('listAdmins', () => {
  it('lists the admins, and whether each has signed in', async () => {
    await replaceAdmins(['alice@example.com', 'bob@example.com'])
    await seeTailnetUser('bob@example.com', 'Bob')
    expect(await listAdmins()).toEqual([
      { login: 'alice@example.com', name: 'alice@example.com', signedIn: false },
      { login: 'bob@example.com', name: 'Bob', signedIn: true },
    ])
  })
})

describe('setUserRole', () => {
  it('sets a role, but never demotes the last admin', async () => {
    const alice = await seeTailnetUser('alice@example.com', 'Alice')
    expect(await setUserRole(alice, 'admin')).toBe('ok')
    expect(await setUserRole(BUILT_IN_USER_ID, 'member')).toBe('ok')
    expect(await setUserRole(alice, 'member')).toBe('last-admin')
    expect((await getUser(alice))?.role).toBe('admin')
  })
})

describe('replaceAdmins', () => {
  it('makes exactly the logins named the admins, giving a new one a row its first sight finds', async () => {
    const bob = await seeTailnetUser('bob@example.com', 'Bob')
    await replaceAdmins(['alice@example.com', 'bob@example.com'])
    expect(Object.fromEntries((await listUsers()).map((u) => [u.login ?? 'built-in', u.role]))).toEqual({
      'built-in': 'member', 'bob@example.com': 'admin', 'alice@example.com': 'admin',
    })
    const alice = await seeTailnetUser('alice@example.com', 'Alice')
    expect(await getUser(alice)).toMatchObject({ name: 'Alice', role: 'admin' })

    await replaceAdmins(['alice@example.com'])
    expect((await getUser(bob))?.role).toBe('member')

    // A revoked login that never signed in is gone, not kept as a member.
    await replaceAdmins(['alice@example.com', 'typo@example.com'])
    await replaceAdmins(['alice@example.com'])
    expect((await listUsers()).map((u) => u.login)).not.toContain('typo@example.com')
  })

  it('refuses as stale, writing nothing, unless the admins are still those expected', async () => {
    await replaceAdmins(['alice@example.com'])
    expect(await replaceAdmins(['bob@example.com'], ['carol@example.com'])).toBe('stale')
    expect((await listAdmins()).map((a) => a.login)).toEqual(['alice@example.com'])
    expect(await replaceAdmins(['bob@example.com'], ['alice@example.com'])).toBe('ok')
    expect((await listAdmins()).map((a) => a.login)).toEqual(['bob@example.com'])
  })
})

describe('recordAccessMode', () => {
  it('replaces the recorded mode, and with a claim gives the built-in user that login', async () => {
    await recordAccessMode('local')
    expect(await readAccessMode()).toBe('local')
    await recordAccessMode('tailnet', { claim: 'alice@example.com' })
    expect(await readAccessMode()).toBe('tailnet')
    expect(await listUsers()).toEqual([{ id: BUILT_IN_USER_ID, login: 'alice@example.com', name: 'alice@example.com', role: 'admin' }])
    // The login now identifies the built-in user, so everything it owns.
    expect(await seeTailnetUser('alice@example.com', 'Alice')).toBe(BUILT_IN_USER_ID)
  })

  it('with admins makes exactly those logins the admins', async () => {
    await recordAccessMode('tailnet', { admins: ['alice@example.com'] })
    expect(await readAccessMode()).toBe('tailnet')
    expect((await listAdmins()).map((a) => a.login)).toEqual(['alice@example.com'])
  })
})
